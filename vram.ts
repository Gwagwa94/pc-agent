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

export async function swapVramModel(
  llm: OpenAI,
  targetModelKey: string,
  roleLabel: 'STRATÈGE 🧠' | 'EXÉCUTANT 🛠️'
): Promise<string> {
  try {
    const loaded = await llm.models.list();
    const match = loaded.data.find(
      (m) => m.id.toLowerCase().includes(targetModelKey.toLowerCase())
    );
    if (match && state.currentlyLoadedModel === match.id) {
      return match.id;
    }
    if (PLANNER_MODEL === EXECUTOR_MODEL && loaded.data.length > 0) {
      const active = loaded.data.find((m) => !m.id.includes('embed')) || loaded.data[0];
      if (active) {
        state.currentlyLoadedModel = active.id;
        return active.id;
      }
    }
  } catch {
    // ignore
  }

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

    const modelsAfter = await llm.models.list();
    const active =
      modelsAfter.data.find((m) => m.id.toLowerCase().includes(targetModelKey.toLowerCase())) ||
      modelsAfter.data.find((m) => !m.id.includes('embed')) ||
      modelsAfter.data[0];

    if (active) {
      state.currentlyLoadedModel = active.id;
      addLog(`✅ [MODÈLE PRÊT] ${roleLabel} actif : ${active.id}`);
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

  return targetModelKey;
}
