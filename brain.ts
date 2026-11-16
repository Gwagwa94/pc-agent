import OpenAI from 'openai';
import { addLog, sleep } from './logger.js';
import { state } from './state.js';
import { PLANNER_MODEL, EXECUTOR_MODEL, swapVramModel } from './vram.js';
import { mcpClient, allAvailableTools, takeFreshSnapshot, pruneOldSnapshots } from './mcp.js';
import { openUrlInChrome, typeTextViaClipboard, sendKeyShortcutReliable } from './windows.js';
import { askGeminiWeb } from './gemini.js';
import type { PlannerDecision, SnapResult } from './types.js';

export async function askPlanner(
  llm: OpenAI,
  userGoal: string,
  executionHistory: string[],
  currentSnap: { text: string; images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] }
): Promise<PlannerDecision> {
  const plannerModelId = await swapVramModel(llm, PLANNER_MODEL, 'STRATÈGE 🧠');

  const allToolNames = allAvailableTools
    .map((t) => (t.type === 'function' ? t.function.name : ''))
    .filter(Boolean);

  const systemPrompt = `Tu es le CERVEAU STRATÈGE (Architecte & Contrôleur) d'un agent PC sous Windows 11.
Tu ne cliques pas toi-même : tu diriges un modèle EXÉCUTANT (UI-TARS) spécialisé en manipulation d'interface.

CATALOGUE COMPLET DES OUTILS DISPONIBLES POUR L'EXÉCUTANT :
- "ComposeGmail" : Ouvre directement la rédaction d'un email Gmail pré-rempli (to, subject, body) et envoie Ctrl+Entrée.
- "OpenUrlInChrome" : Ouvre directement une URL (WhatsApp, Drive, YouTube...) dans Google Chrome.
- "Click" : Clique sur un numéro de "label" exact listé dans "Interactive Elements" du Snapshot.
- "ClickPerMille" : Clique aux coordonnées (x_permille, y_permille) de 0 à 1000‰ sur l'image.
- "TypeRaw" : Colle/tape du texte instantanément au clavier (+ press_enter / press_tab).
- "Shortcut" : Envoie un raccourci clavier (ex: "ctrl+w", "ctrl+enter", "enter", "esc").
- "Scroll" : Fait défiler la page.
- "App" : Lance ou bascule vers une application Windows hors navigateur.
- "PowerShell" : Exécute une commande système Windows.

TON RÔLE À CHAQUE CYCLE :
1. Observe l'objectif global de Grégoire, l'historique des actions déjà réalisées par l'Exécutant, et l'état actuel de l'écran.
2. Décide si l'objectif global est DÉJÀ atteint ("status": "DONE"), impossible ("status": "FAILED"), ou s'il faut lancer un bloc d'exécution ("status": "CONTINUE").
3. Si "CONTINUE" :
   - Donne une instruction ultra-claire et séquentielle à l'Exécutant ("subtask_instruction").
   - Choisis UNIQUEMENT les outils nécessaires ("allowed_tools") parmi ${JSON.stringify(allToolNames)} pour empêcher l'Exécutant de s'éparpiller !
   - Fixe la limite maximale d'étapes ("max_steps", entre 1 et 8) que l'Exécutant a le droit d'utiliser avant de te rendre la main.

Réponds UNIQUEMENT avec un objet JSON valide (sans texte autour, ou dans un bloc json) au format exact :
{
  "status": "CONTINUE" | "DONE" | "FAILED",
  "thought": "Ton analyse stratégique de l'écran actuel",
  "subtask_instruction": "Consigne précise et directe pour l'Exécutant",
  "allowed_tools": ["Outil1", "Outil2"],
  "max_steps": 4,
  "final_response": "Réponse finale pour Grégoire si status est DONE ou FAILED"
}`;

  const historyText =
    executionHistory.length > 0
      ? `HISTORIQUE DES CYCLES PRÉCÉDENTS :\n${executionHistory.join('\n')}`
      : `AUCUNE ACTION EXÉCUTÉE POUR LE MOMENT (Cycle initial).`;

  const response = await llm.chat.completions.create({
    model: plannerModelId,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `OBJECTIF GLOBAL DE GRÉGOIRE : "${userGoal}"\n\n${historyText}\n\nÉTAT ACTUEL DE L'ÉCRAN :\n${currentSnap.text}\n\nDonne ta décision stratégique en JSON :`,
          },
          ...currentSnap.images,
        ],
      },
    ],
  });

  const choice = response.choices[0];
  const rawText = choice?.message?.content || '{}';
  const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<PlannerDecision>;
      const validTools =
        Array.isArray(parsed.allowed_tools) && parsed.allowed_tools.length > 0
          ? parsed.allowed_tools
          : allToolNames;

      return {
        status: parsed.status || 'CONTINUE',
        thought: parsed.thought || 'Analyse effectuée.',
        subtask_instruction: parsed.subtask_instruction || userGoal,
        allowed_tools: validTools,
        max_steps: Math.min(Math.max(Number(parsed.max_steps) || 5, 1), 10),
        final_response: parsed.final_response,
      };
    } catch {
      // Fallback si JSON mal formé
    }
  }

  return {
    status: 'CONTINUE',
    thought: 'Plan par défaut (JSON non détecté).',
    subtask_instruction: userGoal,
    allowed_tools: allToolNames,
    max_steps: 5,
  };
}

export async function runExecutorSubtask(
  llm: OpenAI,
  subtaskInstruction: string,
  allowedToolNames: string[],
  maxSteps: number,
  initialSnap: { text: string; images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] }
): Promise<{
  summary: string[];
  lastSnap: SnapResult;
}> {
  const executorModelId = await swapVramModel(llm, EXECUTOR_MODEL, 'EXÉCUTANT 🛠️');

  const filteredTools = allAvailableTools.filter(
    (t) => t.type === 'function' && allowedToolNames.includes(t.function.name)
  );
  const toolsToPass = filteredTools.length > 0 ? filteredTools : allAvailableTools;

  addLog(
    `🛠️ [EXÉCUTANT] Sous-tâche : "${subtaskInstruction}" | Outils autorisés : [${toolsToPass
      .map((t) => (t.type === 'function' ? t.function.name : ''))
      .filter(Boolean)
      .join(', ')}] | Budget : ${maxSteps} étapes max`
  );

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `Tu es le module EXÉCUTANT (Opérateur GUI Windows 11).
Ton unique rôle est d'exécuter immédiatement la sous-tâche confiée par le Stratège en appelant les outils mis à ta disposition.
RÈGLES D'EXÉCUTION :
1. N'écris pas de long discours : appelle directement l'outil adéquat.
2. Pour cliquer sur un élément qui possède un numéro de "label" dans "Interactive Elements", utilise "Click" {"label": <numero>}.
3. Pour cliquer visuellement sur l'image sans label, utilise "ClickPerMille" {"x_permille": <0-1000>, "y_permille": <0-1000>}.
4. Dès que ta sous-tâche est exécutée, réponds simplement "[SOUS-TÂCHE TERMINÉE]" pour rendre la main au Stratège.`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `ORDRE DU STRATÈGE : "${subtaskInstruction}"\nBudget maximum : ${maxSteps} étapes.\n\nÉtat actuel de l'écran :\n${initialSnap.text}`,
        },
        ...initialSnap.images,
      ],
    },
  ];

  const actionsLog: string[] = [];
  let currentSnap: SnapResult = { ...initialSnap, fgTitle: '' };
  let lastToolCallSignature = '';

  for (let step = 0; step < maxSteps; step++) {
    pruneOldSnapshots(messages);

    const response = await llm.chat.completions.create({
      model: executorModelId,
      messages,
      tools: toolsToPass,
      temperature: 0.15,
    });

    const choice = response.choices[0];
    if (!choice) break;
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const text = (assistantMessage.content || '').trim();
      addLog(`🛠️ [Exécutant -> Stratège] Fin de sous-tâche : ${text.split('\n')[0]}`);
      actionsLog.push(`Note Exécutant : ${text}`);
      break;
    }

    const pendingImages: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const fnName = toolCall.function.name;
      let fnArgs: Record<string, unknown> = {};
      try {
        fnArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        fnArgs = {};
      }

      const sig = `${fnName}(${JSON.stringify(fnArgs)})`;
      if (sig === lastToolCallSignature) {
        addLog(`⚠️ [Exécutant] Doublon évité sur ${sig}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Action ${sig} déjà effectuée juste avant ! Passe à l'action suivante ou réponds [SOUS-TÂCHE TERMINÉE].`,
        });
        continue;
      }
      lastToolCallSignature = sig;

      addLog(`🛠️ [Exécutant Étape ${step + 1}/${maxSteps}] ${fnName} ${JSON.stringify(fnArgs)}`);
      let textResult = '';

      try {
        if (fnName === 'ComposeGmail') {
          const to = encodeURIComponent(String(fnArgs.to || ''));
          const su = encodeURIComponent(String(fnArgs.subject || 'Test'));
          const body = encodeURIComponent(String(fnArgs.body || ''));
          const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${body}`;

          openUrlInChrome(composeUrl);
          await sleep(4500);
          sendKeyShortcutReliable('ctrl+enter');
          await sleep(1800);

          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `Fenêtre Gmail pré-remplie ouverte et Ctrl+Entrée envoyé.\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : ComposeGmail vers ${fnArgs.to} (sujet: ${fnArgs.subject})`);
        } else if (fnName === 'OpenUrlInChrome') {
          const targetUrl = String(fnArgs.url || '');
          openUrlInChrome(targetUrl);
          await sleep(3500);
          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `URL "${targetUrl}" ouverte dans Chrome.\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : OpenUrlInChrome("${targetUrl}")`);
        } else if (fnName === 'TypeRaw') {
          const textToType = String(fnArgs.text || '');
          const pressEnter = fnArgs.press_enter === true || fnArgs.press_enter === 'True';
          const pressTab = fnArgs.press_tab === true || fnArgs.press_tab === 'True';

          typeTextViaClipboard(textToType, pressEnter, pressTab);
          await sleep(pressEnter ? 1600 : 700);
          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `Texte "${textToType}" saisi.\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : TypeRaw("${textToType}", enter=${pressEnter}, tab=${pressTab})`);
        } else if (fnName === 'ClickPerMille') {
          const x_raw = Number(fnArgs.x_permille);
          const y_raw = Number(fnArgs.y_permille);
          const x_pixel = Math.round((x_raw / 1000) * state.screenDimensions.width);
          const y_pixel = Math.round((y_raw / 1000) * state.screenDimensions.height);

          addLog(`🎯 Clic (${x_raw}‰, ${y_raw}‰) -> pixels (${x_pixel}, ${y_pixel})`);
          await mcpClient.callTool({
            name: 'Click',
            arguments: { loc: [x_pixel, y_pixel] },
          });
          await sleep(1000);
          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `Clic effectué à (${x_raw}‰, ${y_raw}‰).\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : ClickPerMille(${x_raw}‰, ${y_raw}‰)`);
        } else if (fnName === 'Shortcut') {
          const sc = String(fnArgs.shortcut || '');
          if (!sendKeyShortcutReliable(sc)) {
            await mcpClient.callTool({ name: 'Shortcut', arguments: fnArgs });
          }
          await sleep(1000);
          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `Raccourci "${sc}" exécuté.\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : Shortcut("${sc}")`);
        } else if (fnName === 'ask_gemini_web') {
          textResult = await askGeminiWeb(String(fnArgs.prompt || ''));
          actionsLog.push(`Exécuté : ask_gemini_web`);
        } else {
          const mcpResult = await mcpClient.callTool({
            name: fnName,
            arguments: fnArgs,
          });
          await sleep(900);
          currentSnap = await takeFreshSnapshot();
          pendingImages.push(...currentSnap.images);
          textResult = `${JSON.stringify(mcpResult.content || 'OK')}\n${currentSnap.text}`;
          actionsLog.push(`Exécuté : ${fnName}(${JSON.stringify(fnArgs)})`);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        addLog(`❌ Erreur Exécutant sur ${fnName}: ${errorMessage}`);
        textResult = `Erreur: ${errorMessage}`;
        actionsLog.push(`Erreur sur ${fnName}: ${errorMessage}`);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: textResult,
      });
    }

    if (pendingImages.length > 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Voici le nouvel écran après ton action. Si la sous-tâche du Stratège est remplie, réponds [SOUS-TÂCHE TERMINÉE], sinon fais la prochaine action :',
          },
          ...pendingImages,
        ],
      });
    }
  }

  return {
    summary: actionsLog.length > 0 ? actionsLog : ['Aucune action outil appelée.'],
    lastSnap: currentSnap,
  };
}

export async function runAgentTask(llm: OpenAI, userInstruction: string): Promise<string> {
  const MAX_CYCLES = 4;
  const globalHistory: string[] = [];

  let currentSnap = await takeFreshSnapshot();

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    addLog(`\n================= 🧠 CYCLE STRATÉGIQUE ${cycle}/${MAX_CYCLES} =================`);

    const decision = await askPlanner(llm, userInstruction, globalHistory, currentSnap);

    addLog(`🧠 [Stratège] Pensée : ${decision.thought}`);

    if (decision.status === 'DONE') {
      return decision.final_response || `✅ Mission accomplie : ${decision.thought}`;
    }

    if (decision.status === 'FAILED') {
      return decision.final_response || `❌ Échec constaté par le Stratège : ${decision.thought}`;
    }

    const execResult = await runExecutorSubtask(
      llm,
      decision.subtask_instruction,
      decision.allowed_tools,
      decision.max_steps,
      currentSnap
    );

    currentSnap = execResult.lastSnap;
    globalHistory.push(
      `--- Cycle ${cycle} (Sous-tâche : "${decision.subtask_instruction}") ---\n` +
        execResult.summary.map((s) => `  • ${s}`).join('\n')
    );
  }

  return `Limite de ${MAX_CYCLES} cycles stratégiques atteinte. Historique :\n${globalHistory.join('\n')}`;
}
