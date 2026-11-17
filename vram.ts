import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import { addLog, sleep } from './logger.js';
import { state } from './state.js';

export let PLANNER_MODEL = process.env.PLANNER_MODEL || 'gemma-4-26b-a4b';
export let EXECUTOR_MODEL = process.env.EXECUTOR_MODEL || 'ui-tars-1.5-7b';
export let PLANNER_CONTEXT_LENGTH = process.env.PLANNER_CONTEXT_LENGTH || '32768';
export let EXECUTOR_CONTEXT_LENGTH = process.env.EXECUTOR_CONTEXT_LENGTH || '16384';

export function resolveLmsCliPath(): string {
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\grego';
  const candidates = [
    path.join(userProfile, '.lmstudio', 'bin', 'lms.exe'),
    path.join(userProfile, 'AppData', 'Local', 'LM-Studio', 'app-0.3.0', 'resources', 'bin', 'lms.exe'),
    'lms',
  ];
  for (const c of candidates) {
    if (c !== 'lms' && fs.existsSync(c)) return `"${c}"`;
  }
  return 'lms';
}

export function getLoadedModelsViaCli(): Array<{ id: string; key: string; parallel?: number }> {
  try {
    const lmsCmd = resolveLmsCliPath();
    const stdout = execSync(`${lmsCmd} ps --json`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString();
    const data = JSON.parse(stdout);
    if (Array.isArray(data)) {
      return data
        .filter((m: any) => m.type === 'llm')
        .map((m: any) => ({
          id: m.identifier || m.modelKey || '',
          key: m.modelKey || m.identifier || '',
          parallel: typeof m.parallel === 'number' ? m.parallel : undefined,
        }));
    }
  } catch {
    // ignore
  }
  return [];
}

export function syncLoadedModelAtStartup(): void {
  const loaded = getLoadedModelsViaCli();
  if (loaded.length > 0 && loaded[0]) {
    const first = loaded[0];
    state.currentlyLoadedModel = first.id;
    addLog(`⚡ [LM STUDIO] Modèle déjà chargé en mémoire au démarrage : "${first.id}" (Parallel: ${first.parallel ?? 'auto'})`);
  } else {
    addLog(`ℹ️ [LM STUDIO] Aucun modèle chargé en mémoire au démarrage.`);
  }
}

export async function swapVramModel(
  llm: OpenAI,
  targetModelKey: string,
  roleLabel: 'STRATÈGE 🧠' | 'EXÉCUTANT 🛠️'
): Promise<string> {
  const targetLower = targetModelKey.toLowerCase();

  // 1. Déjà enregistré comme actif dans notre state interne ?
  if (state.currentlyLoadedModel && state.currentlyLoadedModel.toLowerCase().includes(targetLower)) {
    return state.currentlyLoadedModel;
  }

  // 2. Vérification directe dans LM Studio via lms ps --json (~300ms)
  const currentlyLoaded = getLoadedModelsViaCli();
  const alreadyActive = currentlyLoaded.find(
    (m) => m.id.toLowerCase().includes(targetLower) || m.key.toLowerCase().includes(targetLower)
  );

  if (alreadyActive) {
    // Si déjà chargé mais avec Parallel > 1, on alerte et on recharge pour éviter le crash CUDA OOM
    if (alreadyActive.parallel && alreadyActive.parallel > 1) {
      addLog(
        `⚠️ [ATTENTION] "${alreadyActive.id}" a été chargé avec Parallel: ${alreadyActive.parallel} (risque de crash CUDA OOM). Rechargement en Parallel: 1...`
      );
    } else {
      state.currentlyLoadedModel = alreadyActive.id;
      addLog(`⚡ [MODÈLE DÉJÀ PRÊT] ${roleLabel} déjà actif dans LM Studio : ${alreadyActive.id}`);
      return alreadyActive.id;
    }
  }

  // 3. Modèle absent ou mal configuré -> Swap nécessaire
  const lmsCmd = resolveLmsCliPath();
  const isLargeMoE = /26b|27b|30b|a4b|a3b/i.test(targetModelKey);
  const gpuFlag = isLargeMoE ? '' : '--gpu max';
  const contextLength = isLargeMoE ? PLANNER_CONTEXT_LENGTH : EXECUTOR_CONTEXT_LENGTH;
  const contextFlag = contextLength ? `-c ${contextLength}` : '';

  addLog(
    `🔄 [SWAP VRAM/RAM -> ${roleLabel}] Chargement de "${targetModelKey}" (${
      isLargeMoE ? 'Hybride 8Go VRAM + 32Go RAM' : '100% VRAM GPU'
    } | Contexte : ${contextLength} tokens)...`
  );

  try {
    execSync(`${lmsCmd} unload --all`, { stdio: 'ignore', timeout: 20000 });
    await sleep(400);

    execSync(`${lmsCmd} load "${targetModelKey}" ${gpuFlag} ${contextFlag} --parallel 1 -y`, {
      stdio: 'ignore',
      timeout: 90000,
    });
    await sleep(800);

    const afterList = getLoadedModelsViaCli();
    const active =
      afterList.find((m) => m.id.toLowerCase().includes(targetLower) || m.key.toLowerCase().includes(targetLower)) ||
      afterList[0];

    if (active) {
      state.currentlyLoadedModel = active.id;
      addLog(`✅ [MODÈLE PRÊT] ${roleLabel} actif : ${active.id} (Parallel: ${active.parallel ?? 1})`);
      return active.id;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(
      `⚠️ Swap CLI lms non disponible ou modèle non trouvé (${msg}). Utilisation du modèle déjà chargé dans LM Studio.`
    );
    try {
      const fallbackList = await llm.models.list();
      const first = fallbackList.data.find((m) => !m.id.includes('embed')) || fallbackList.data[0];
      if (first) {
        state.currentlyLoadedModel = first.id;
        return first.id;
      }
    } catch {
      // ignore
    }
  }

  state.currentlyLoadedModel = targetModelKey;
  return targetModelKey;
}
