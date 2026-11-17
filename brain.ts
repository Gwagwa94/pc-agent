import OpenAI from 'openai';
import { addLog, sleep } from './logger.js';
import { state } from './state.js';
import { PLANNER_MODEL, EXECUTOR_MODEL, swapVramModel } from './vram.js';
import { mcpClient, allAvailableTools, takeFreshSnapshot, pruneOldSnapshots } from './mcp.js';
import { openUrlInChrome, typeTextViaClipboard, sendKeyShortcutReliable } from './windows.js';
import { askGeminiWeb } from './gemini.js';
import fs from 'fs';
import path from 'path';
import { getForegroundWindowTitle } from './powershell.js';
import type { PlannerDecision, SnapResult } from './types.js';
import {
  getConversation,
  logConversationAction,
  saveConversationSnapshot,
  searchPastConversations,
  readPastConversationDetails,
  type ChatMessage,
} from './conversations.js';

function isSimpleGreeting(text: string): string | null {
  const trimmed = text.trim().toLowerCase().replace(/[!?.,;:\s]+$/, '');
  const greetings = [
    'hello', 'hi', 'hey', 'bonjour', 'salut', 'coucou', 'yo', 'bonsoir',
    'test', 'ping', 'qui es-tu', 'qui es tu', 'qui est tu',
    'ca va', 'ça va', 'comment vas-tu', 'comment tu vas'
  ];
  if (greetings.includes(trimmed)) {
    const responses: Record<string, string> = {
      hello: "Hello Grégoire ! Je suis ton agent autonome Dual-Brain. Que veux-tu que je fasse sur ton PC ?",
      hi: "Hi ! Je suis connecté et prêt. Quelle tâche souhaites-tu lancer ?",
      bonjour: "Bonjour Grégoire ! Je suis opérationnel sur ton PC Windows 11. Que puis-je faire pour toi ?",
      bonsoir: "Bonsoir Grégoire ! Tout est prêt. Quel ordre souhaites-tu exécuter ?",
      salut: "Salut Grégoire ! Je suis à ton écoute pour piloter le PC. Quel est ton objectif ?",
      ping: "Pong 🏓 ! L'agent PC et la liaison WireGuard répondent instantanément.",
      test: "Test reçu 5/5 ! Le système Dual-Brain et les outils Windows sont prêts.",
    };
    return responses[trimmed] || "Bonjour ! Je suis ton agent PC autonome. Dis-moi ce que tu veux faire !";
  }
  return null;
}

export async function askPlanner(
  llm: OpenAI,
  userGoal: string,
  executionHistory: string[],
  currentSnap: { text: string; images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] },
  chatHistory?: ChatMessage[]
): Promise<PlannerDecision> {
  const plannerModelId = await swapVramModel(llm, PLANNER_MODEL, 'STRATÈGE 🧠');

  const allToolNames = allAvailableTools
    .map((t) => (t.type === 'function' ? t.function.name : ''))
    .filter(Boolean);

  const systemPrompt = `Tu es le CERVEAU STRATÈGE (Architecte & Décideur) d'un agent autonome sous Windows 11.
Tu ne cliques pas toi-même : tu réfléchis, tu analyses et tu diriges un modèle EXÉCUTANT (UI-TARS) spécialisé dans le clic GUI.

CATALOGUE COMPLET DES OUTILS POUR L'EXÉCUTANT :
- "OpenUrlInChrome" : Ouvre directement une URL (ex: "https://sheets.new" pour Google Sheets, "https://docs.new" pour Docs, "https://web.whatsapp.com", etc.) dans Chrome.
- "ComposeGmail" : Ouvre directement la rédaction d'un email Gmail pré-rempli (to, subject, body) et envoie Ctrl+Entrée.
- "Click" : Clique sur un numéro de "label" exact listé dans "Interactive Elements" du Snapshot.
- "ClickPerMille" : Clique aux coordonnées (x_permille, y_permille) de 0 à 1000‰ sur l'image.
- "TypeRaw" : Colle/tape du texte instantanément au clavier (+ press_enter / press_tab).
- "Shortcut" : Envoie un raccourci clavier (ex: "ctrl+w", "ctrl+enter", "enter", "esc").
- "Scroll" : Fait défiler la page.
- "App" : Lance ou bascule vers une application Windows hors navigateur.
- "PowerShell" : Exécute une commande système Windows.
- "RecallPastConversation" : Consulte les archives (conversation.txt / execution.log) des sessions passées pour se souvenir d'une information.

RÈGLES STRATÉGIQUES ESSENTIELLES :
1. STRATÉGIE DE PROGRAMMATION PAR BATCH (ANTI-SWAP VRAM) :
   Pour éviter des allers-retours de swap VRAM inutiles, ne découpe pas une tâche logique en micro-étapes isolées !
   Donne à l'Exécutant une séquence d'actions complète dans "subtask_instruction" qu'il exécutera en une seule session (fixe max_steps entre 4 et 8) :
   Exemple :
   "1. Ouvre 'https://sheets.new' avec OpenUrlInChrome.
   2. Clique sur la première cellule ou zone de saisie.
   3. Tape le titre et le contenu via TypeRaw ligne par ligne."
   Allowed tools: ["OpenUrlInChrome", "Click", "ClickPerMille", "TypeRaw", "Shortcut"]
   Max steps: 6
   De cette façon, l'Exécutant déroule toute la séquence d'une traite en VRAM sans swap intermédiaire !

2. NAVIGATION WEB & SERVICES GOOGLE (Google Sheets, Docs, YouTube, etc.) :
   Ne cherche JAMAIS à cliquer sur la barre des tâches ou sur l'icône Chrome !
   Utilise IMMÉDIATEMENT "OpenUrlInChrome" avec l'URL directe :
   - Pour Google Sheets : subtask_instruction="1. Ouvre https://sheets.new dans Chrome. 2. Tape la recette dans les cellules...", allowed_tools=["OpenUrlInChrome", "Click", "ClickPerMille", "TypeRaw"], max_steps=5
   - Pour Google Docs : subtask_instruction="1. Ouvre https://docs.new dans Chrome. 2. Tape le document...", allowed_tools=["OpenUrlInChrome", "TypeRaw"], max_steps=4
   - Pour tout site : donne l'URL directe avec "OpenUrlInChrome".

3. GESTION DE TON BUDGET DE SORTIE :
   - Ton budget de réponse est de 2048 tokens.
   - Si la tâche nécessite d'écrire un contenu complet (recette, résumé, données), pré-rédige ce contenu directement dans la consigne de TypeRaw pour que l'Exécutant le colle d'un coup dans l'application !

4. QUESTION SIMPLE OU SALUTATION :
   Si Grégoire pose une question ou salue sans manipulation requise, réponds directement :
   {"status": "DONE", "thought": "Réponse directe.", "final_response": "Ta réponse"}

5. INSPECTION D'ÉCRAN :
   Si tu as besoin de voir l'écran pour localiser un élément graphique avant d'ordonner la suite :
   {"status": "NEED_SNAPSHOT", "thought": "Capture requise"}

Format JSON STRICT (sans texte autour) :
{
  "status": "CONTINUE" | "DONE" | "FAILED" | "NEED_SNAPSHOT",
  "thought": "Ton analyse stratégique",
  "subtask_instruction": "Séquence complète et ordonnée pour l'Exécutant si status=CONTINUE",
  "allowed_tools": ["OpenUrlInChrome", "TypeRaw", "ClickPerMille"],
  "max_steps": 6,
  "final_response": "Réponse finale pour Grégoire si status est DONE ou FAILED"
}`;

  let chatContext = '';
  if (chatHistory && chatHistory.length > 0) {
    const previousExchanges = chatHistory.filter((m) => m.content !== userGoal).slice(-6);
    if (previousExchanges.length > 0) {
      chatContext =
        `CONTEXTE DE LA DISCUSSION EN COURS AVEC GRÉGOIRE :\n` +
        previousExchanges
          .map((m) => `- ${m.role === 'user' ? 'Grégoire' : 'Agent'} : "${m.content.slice(0, 180)}"`)
          .join('\n') +
        `\n\n`;
    }
  }

  const historyText =
    executionHistory.length > 0
      ? `HISTORIQUE DES ACTIONS DE CE CYCLE :\n${executionHistory.join('\n')}`
      : `AUCUNE ACTION EXÉCUTÉE DANS CE CYCLE (Phase initiale).`;

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: `${chatContext}OBJECTIF ACTUEL DE GRÉGOIRE : "${userGoal}"\n\n${historyText}\n\nÉTAT ACTUEL DE L'ÉCRAN :\n${
        currentSnap.text ||
        '(Aucune capture visuelle pour l’instant - réponds NEED_SNAPSHOT si tu as besoin de voir l’écran)'
      }\n\nDonne ta décision stratégique en JSON :`,
    },
  ];

  if (currentSnap.images.length > 0) {
    userContent.push(...currentSnap.images);
  }

  const response = await llm.chat.completions.create({
    model: plannerModelId,
    temperature: 0.1,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const choice = response.choices[0];
  const rawText = choice?.message?.content || '{}';
  const cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Extraction JSON tolérante (code blocks ```json ... ``` ou accolades { ... })
  let jsonString = '';
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    jsonString = codeBlockMatch[1];
  } else {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonString = jsonMatch[0];
  }

  if (jsonString) {
    try {
      const parsed = JSON.parse(jsonString) as Partial<PlannerDecision>;
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
      // Fallback si JSON syntaxiquement incomplet
    }
  }

  // Détection intelligente si le modèle a suggéré une URL directe dans son texte libre
  const directUrl = cleaned.match(/https?:\/\/[^\s"'`)]+/i);
  if (directUrl) {
    return {
      status: 'CONTINUE',
      thought: `Navigation web vers ${directUrl[0]} requise.`,
      subtask_instruction: `Ouvre la page ${directUrl[0]} dans Google Chrome`,
      allowed_tools: ['OpenUrlInChrome'],
      max_steps: 1,
    };
  }

  return {
    status: 'CONTINUE',
    thought: 'Plan par défaut (continuation).',
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

      // Cas 1 : Coordonnées de clic brutes émises par UI-TARS (ex: "(286,872)" ou "(286, 872)" ou "click(point=[286, 872])")
      const coordMatch =
        text.match(/^\(?\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\)?$/) ||
        text.match(/(?:click|point|loc)\s*=?\s*\[?\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\]?/i) ||
        text.match(/(\d{1,4})\s*,\s*(\d{1,4})/);

      if (coordMatch && !text.includes('[SOUS-TÂCHE TERMINÉE]')) {
        const x = parseInt(coordMatch[1]!, 10);
        const y = parseInt(coordMatch[2]!, 10);
        if (x <= state.screenDimensions.width + 100 && y <= state.screenDimensions.height + 100) {
          addLog(`🎯 [Auto-Parse UI-TARS] Coordonnées de clic détectées : (${x}, ${y}) -> Exécution du clic`);
          try {
            await mcpClient.callTool({
              name: 'Click',
              arguments: { loc: [x, y] },
            });
            await sleep(1500);
            currentSnap = await takeFreshSnapshot();
            actionsLog.push(`Exécuté : Clic(${x}, ${y})`);
            messages.push({
              role: 'user',
              content: `Clic effectué aux coordonnées (${x}, ${y}). Nouvel état de l'écran :\n${currentSnap.text}`,
            });
            continue; // Le clic a été effectué, on poursuit la sous-tâche !
          } catch (e) {
            addLog(`❌ Erreur lors du clic auto-parsé : ${e}`);
          }
        }
      }

      // Cas 2 : Ordre d'ouverture d'URL directe
      const urlMatch = text.match(/https?:\/\/[^\s"'`)]+/i);
      if (urlMatch && /ouvr|open|navig|va sur|sheets|docs/i.test(text)) {
        const url = urlMatch[0];
        addLog(`🌐 [Auto-Parse UI-TARS] Ordre d'ouverture d'URL détecté : "${url}"`);
        openUrlInChrome(url);
        await sleep(3500);
        currentSnap = await takeFreshSnapshot();
        actionsLog.push(`Exécuté : OpenUrlInChrome("${url}")`);
        messages.push({
          role: 'user',
          content: `Page "${url}" ouverte dans Google Chrome. Nouvel état de l'écran :\n${currentSnap.text}`,
        });
        continue;
      }

      // Cas 3 : Fin normale de sous-tâche
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
        } else if (fnName === 'RecallPastConversation') {
          const q = String(fnArgs.query || '');
          const cId = String(fnArgs.conversationId || '');
          const t = fnArgs.fileType === 'log' ? 'log' : 'chat';
          if (cId) {
            textResult = readPastConversationDetails(cId, t);
          } else {
            textResult = searchPastConversations(q);
          }
          actionsLog.push(`Exécuté : RecallPastConversation(query="${q}", id="${cId}")`);
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

export async function runAgentTask(
  llm: OpenAI,
  userInstruction: string,
  conversationId?: string
): Promise<string> {
  // 1. Fast-Path immédiat pour salutations et tests simples (réponse < 10ms)
  const quick = isSimpleGreeting(userInstruction);
  if (quick) {
    addLog(`⚡ [Fast Path] Réponse instantanée : "${quick}"`);
    if (conversationId) {
      logConversationAction(conversationId, { thought: 'Fast Path salutation', result: quick });
    }
    return quick;
  }

  const conv = conversationId ? getConversation(conversationId) : null;
  const chatHistory = conv?.messages;

  const MAX_CYCLES = 4;
  const globalHistory: string[] = [];

  // Prise d'état ultra-légère au départ (titre de la fenêtre active sous Windows en 30ms, AUCUNE capture visuelle lourde !)
  const initialFgTitle = getForegroundWindowTitle();
  let currentSnap: SnapResult = {
    text: initialFgTitle ? `📌 FENÊTRE ACTIVE CONFIRMÉE : "${initialFgTitle}"` : '',
    images: [],
    fgTitle: initialFgTitle,
  };

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    addLog(`\n================= 🧠 CYCLE STRATÉGIQUE ${cycle}/${MAX_CYCLES} =================`);

    // 1. Le Stratège (Gemma 4 / UI-TARS) décide d'abord en texte pur avec le contexte de la conversation
    const decision = await askPlanner(llm, userInstruction, globalHistory, currentSnap, chatHistory);
    addLog(`🧠 [Stratège] Pensée : ${decision.thought}`);

    if (conversationId) {
      logConversationAction(conversationId, {
        cycle,
        thought: decision.thought,
        subtask: decision.subtask_instruction,
      });
    }

    if (decision.status === 'DONE') {
      const finalRes = decision.final_response || `✅ Mission accomplie : ${decision.thought}`;
      if (conversationId) logConversationAction(conversationId, { cycle, result: finalRes });
      return finalRes;
    }

    if (decision.status === 'FAILED') {
      const failRes = decision.final_response || `❌ Échec constaté par le Stratège : ${decision.thought}`;
      if (conversationId) logConversationAction(conversationId, { cycle, result: failRes });
      return failRes;
    }

    // Si le Stratège a expressément demandé à voir l'écran :
    if (decision.status === 'NEED_SNAPSHOT') {
      addLog(`📸 [Stratège] Prise de capture d'écran requise pour analyser l'interface...`);
      currentSnap = await takeFreshSnapshot();
      if (conversationId) {
        const snapPath = path.join(process.cwd(), 'last_snapshot.png');
        if (fs.existsSync(snapPath)) {
          saveConversationSnapshot(conversationId, cycle, 'strategist_requested', fs.readFileSync(snapPath));
        }
      }
      globalHistory.push(`--- Cycle ${cycle} : Capture d'écran effectuée à la demande du Stratège (Fenêtre: "${currentSnap.fgTitle}"). ---`);
      continue;
    }

    // 2. Si le Stratège délègue à l'Exécutant (UI-TARS) :
    // Si l'Exécutant a besoin d'outils de clic visuel mais qu'on n'a pas encore d'image :
    const needsVisualSnap = decision.allowed_tools.some((t) => ['Click', 'ClickPerMille'].includes(t));
    if (needsVisualSnap && currentSnap.images.length === 0) {
      addLog(`📸 Prise de capture visuelle pour l'Exécutant UI-TARS...`);
      currentSnap = await takeFreshSnapshot();
      if (conversationId) {
        const snapPath = path.join(process.cwd(), 'last_snapshot.png');
        if (fs.existsSync(snapPath)) {
          saveConversationSnapshot(conversationId, cycle, 'executor_visual', fs.readFileSync(snapPath));
        }
      }
    }

    const execResult = await runExecutorSubtask(
      llm,
      decision.subtask_instruction,
      decision.allowed_tools,
      decision.max_steps,
      currentSnap
    );

    if (conversationId) {
      logConversationAction(conversationId, {
        cycle,
        action: execResult.summary.join(' | '),
      });
    }

    currentSnap = execResult.lastSnap;
    globalHistory.push(
      `--- Cycle ${cycle} (Sous-tâche : "${decision.subtask_instruction}") ---\n` +
        execResult.summary.map((s) => `  • ${s}`).join('\n')
    );
  }

  return `Limite de ${MAX_CYCLES} cycles stratégiques atteinte. Historique :\n${globalHistory.join('\n')}`;
}
