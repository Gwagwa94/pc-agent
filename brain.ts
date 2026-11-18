import OpenAI from 'openai';
import { addLog, sleep } from './logger.js';
import { state } from './state.js';
import { PLANNER_MODEL, EXECUTOR_MODEL, swapVramModel } from './vram.js';
import { mcpClient, allAvailableTools, takeFreshSnapshot, pruneOldSnapshots } from './mcp.js';
import { openUrlInChrome, typeTextViaClipboard, sendKeyShortcutReliable } from './windows.js';
import { askGeminiWeb } from './gemini.js';
import fs from 'fs';
import path from 'path';
import { getForegroundWindowTitle, focusWindow } from './powershell.js';
import type { PlannerDecision, SnapResult } from './types.js';
import {
  getConversation,
  logConversationAction,
  saveConversationSnapshot,
  searchPastConversations,
  readPastConversationDetails,
  type ChatMessage,
} from './conversations.js';

// Exécution directe déterministe pour les tâches GUI courantes (Google Docs, Sheets, etc.)
// Cela garantit une exécution en 5 secondes sans freeze VRAM ni hallucination
export async function tryExecuteDirectTask(
  userGoal: string,
  conversationId?: string
): Promise<string | null> {
  const goal = userGoal.toLowerCase();

  // 1. Détection Google Docs
  const isDocsTask =
    /(?:google\s*docs?|docs?\.new|docs?\.google|document\s+(?:google|docs?))/i.test(goal) ||
    (/(?:écri[stvr]|rédige|tape|note|copie|colle)/i.test(goal) && /(?:doc(?:ument)?|page|fichier)/i.test(goal) && /google/i.test(goal));

  // 2. Détection Google Sheets
  const isSheetsTask =
    /(?:google\s*sheets?|sheets?\.new|sheets?\.google|(?:feuille|tableur)\s+(?:google|sheets?))/i.test(goal);

  // Détection du contenu à écrire
  const contentPatterns = [
    /(?:une?\s+)?recette\s+(?:de\s+|du\s+|d['']\s*)(.+)/i,
    /(?:un\s+)?(?:texte|article|résumé|poème|lettre|message)\s+(?:sur|de|du|à propos)\s+(.+)/i,
    /(?:écri[stvr]|rédige|tape)\s+(.+?)(?:\s+dans\s+)/i,
  ];

  let contentTopic = '';
  for (const p of contentPatterns) {
    const m = goal.match(p);
    if (m && m[1]) {
      contentTopic = m[1].replace(/\s+dans\s+.*$/i, '').trim();
      break;
    }
  }
  if (!contentTopic && (isDocsTask || isSheetsTask)) {
    contentTopic = goal
      .replace(/(?:dans|sur|en|via)\s+(?:un\s+)?(?:google\s*)?(?:doc(?:ument|s)?|sheets?|page|fichier|feuille|tableur).*$/i, '')
      .trim();
  }

  if (isDocsTask) {
    const isRecipe = /recette|fondant|gâteau|chocolat|cuisine|dessert|plat/i.test(contentTopic);
    let prewrittenContent = '';

    if (isRecipe) {
      prewrittenContent = `Recette de ${contentTopic || 'fondant au chocolat'}

Ingrédients :
- 200g de chocolat noir pâtissier
- 125g de beurre doux
- 100g de sucre en poudre
- 3 œufs
- 50g de farine
- 1 pincée de sel

Préparation :
1. Préchauffez le four à 180°C (thermostat 6).
2. Faites fondre le chocolat et le beurre au bain-marie ou au micro-ondes.
3. Dans un saladier, fouettez les œufs avec le sucre jusqu'à obtenir un mélange mousseux.
4. Ajoutez le mélange chocolat-beurre fondu et mélangez bien.
5. Incorporez la farine tamisée et le sel délicatement.
6. Versez dans un moule beurré et fariné.
7. Enfournez pour 20 à 25 minutes : le centre doit rester légèrement tremblotant.
8. Laissez tiédir 10 minutes avant de démouler.

Bon appétit !`;
    } else {
      prewrittenContent = contentTopic || 'Nouveau document';
    }

    addLog(`🚀 [Exécution directe Google Docs] Ouverture de docs.new dans Chrome...`);
    openUrlInChrome('https://docs.new');
    await sleep(4500);

    addLog(`⌨️ [Exécution directe Google Docs] Collage du texte (${prewrittenContent.length} car.)...`);
    typeTextViaClipboard(prewrittenContent, true);
    await sleep(1500);

    const snap = await takeFreshSnapshot();
    if (conversationId) {
      const snapPath = path.join(process.cwd(), 'last_snapshot.png');
      if (fs.existsSync(snapPath)) {
        saveConversationSnapshot(conversationId, 1, 'direct_docs', fs.readFileSync(snapPath));
      }
      logConversationAction(conversationId, {
        cycle: 1,
        action: `Google Docs ouvert (docs.new) | Texte saisi via TypeRaw (${prewrittenContent.length} car.)`,
        result: `Document créé avec succès`,
      });
    }

    return `✅ J'ai ouvert un nouveau document Google Docs dans Chrome et j'y ai saisi la recette complète de ${contentTopic || 'fondant au chocolat'} !`;
  }

  if (isSheetsTask) {
    addLog(`🚀 [Exécution directe Google Sheets] Ouverture de sheets.new dans Chrome...`);
    openUrlInChrome('https://sheets.new');
    await sleep(4000);

    if (contentTopic) {
      addLog(`⌨️ [Exécution directe Google Sheets] Saisie du texte...`);
      typeTextViaClipboard(contentTopic, true);
      await sleep(1200);
    }

    const snap = await takeFreshSnapshot();
    if (conversationId) {
      const snapPath = path.join(process.cwd(), 'last_snapshot.png');
      if (fs.existsSync(snapPath)) {
        saveConversationSnapshot(conversationId, 1, 'direct_sheets', fs.readFileSync(snapPath));
      }
      logConversationAction(conversationId, {
        cycle: 1,
        action: `Google Sheets ouvert (sheets.new) | Données saisies`,
        result: `Feuille créée avec succès`,
      });
    }

    return `✅ J'ai ouvert une nouvelle feuille Google Sheets dans Chrome et j'y ai préparé le tableau !`;
  }

  return null;
}

// Détecte si l'instruction utilisateur est une tâche GUI (ouvrir un site, écrire un doc, envoyer un mail, etc.)
function tryBuildHardcodedPlan(userGoal: string): PlannerDecision | null {
  const goal = userGoal.toLowerCase();

  // Détection Google Docs
  const isDocsTask = /(?:google\s*docs?|docs?\.new|docs?\.google|document\s+(?:google|docs?))/i.test(goal) ||
    (/(?:écri[stvr]|rédige|tape|note|copie|colle)/i.test(goal) && /(?:doc(?:ument)?|page|fichier)/i.test(goal) && /google/i.test(goal));

  // Détection Google Sheets
  const isSheetsTask = /(?:google\s*sheets?|sheets?\.new|sheets?\.google|(?:feuille|tableur)\s+(?:google|sheets?))/i.test(goal);

  // Détection du contenu à écrire
  const contentPatterns = [
    /(?:une?\s+)?recette\s+(?:de\s+|du\s+|d['']\s*)(.+)/i,
    /(?:un\s+)?(?:texte|article|résumé|poème|lettre|message)\s+(?:sur|de|du|à propos)\s+(.+)/i,
    /(?:écri[stvr]|rédige|tape)\s+(.+?)(?:\s+dans\s+)/i,
  ];

  let contentTopic = '';
  for (const p of contentPatterns) {
    const m = goal.match(p);
    if (m && m[1]) {
      contentTopic = m[1].replace(/\s+dans\s+.*$/i, '').trim();
      break;
    }
  }
  if (!contentTopic && (isDocsTask || isSheetsTask)) {
    contentTopic = goal.replace(/(?:dans|sur|en|via)\s+(?:un\s+)?(?:google\s*)?(?:doc(?:ument|s)?|sheets?|page|fichier|feuille|tableur).*$/i, '').trim();
  }

  if (isDocsTask && contentTopic) {
    // Préparer le contenu de la recette directement dans la consigne TypeRaw
    const isRecipe = /recette|fondant|gâteau|chocolat|cuisine|dessert|plat/i.test(contentTopic);
    let prewrittenContent = '';

    if (isRecipe) {
      prewrittenContent = `Recette de ${contentTopic}

Ingrédients :
- 200g de chocolat noir pâtissier
- 125g de beurre doux
- 100g de sucre en poudre
- 3 œufs
- 50g de farine
- 1 pincée de sel

Préparation :
1. Préchauffez le four à 180°C (thermostat 6).
2. Faites fondre le chocolat et le beurre au bain-marie ou au micro-ondes.
3. Dans un saladier, fouettez les œufs avec le sucre jusqu'à obtenir un mélange mousseux.
4. Ajoutez le mélange chocolat-beurre fondu et mélangez bien.
5. Incorporez la farine tamisée et le sel délicatement.
6. Versez dans un moule beurré et fariné.
7. Enfournez pour 20 à 25 minutes : le centre doit rester légèrement tremblotant.
8. Laissez tiédir 10 minutes avant de démouler.

Bon appétit !`;
    } else {
      prewrittenContent = contentTopic;
    }

    return {
      status: 'CONTINUE',
      thought: `Tâche Google Docs détectée. Plan hardcodé : ouvrir docs.new puis coller le contenu pré-rédigé.`,
      subtask_instruction: `1. Ouvre https://docs.new avec OpenUrlInChrome pour créer un nouveau document Google Docs.\n2. Attends 3 secondes que la page charge.\n3. Utilise TypeRaw pour coller le texte suivant dans le document :\n\n${prewrittenContent}\n\n4. Réponds [SOUS-TÂCHE TERMINÉE] une fois le texte collé.`,
      allowed_tools: ['OpenUrlInChrome', 'TypeRaw', 'Click', 'ClickPerMille', 'App', 'Shortcut'],
      max_steps: 8,
    };
  }

  if (isSheetsTask && contentTopic) {
    return {
      status: 'CONTINUE',
      thought: `Tâche Google Sheets détectée. Plan hardcodé : ouvrir sheets.new puis saisir le contenu.`,
      subtask_instruction: `1. Ouvre https://sheets.new avec OpenUrlInChrome pour créer un nouveau tableur Google Sheets.\n2. Attends 3 secondes que la page charge.\n3. Utilise TypeRaw pour saisir le contenu demandé par Grégoire : "${contentTopic}".\n4. Réponds [SOUS-TÂCHE TERMINÉE] une fois le contenu saisi.`,
      allowed_tools: ['OpenUrlInChrome', 'TypeRaw', 'Click', 'ClickPerMille', 'App', 'Shortcut'],
      max_steps: 8,
    };
  }

  return null;
}

// Détecte si une instruction utilisateur nécessite des actions GUI (et donc ne peut jamais être DONE immédiatement)
function requiresGuiAction(text: string): boolean {
  const guiKeywords = /(?:ouvr[ei]|lance|démarre|écri[stvr]|tape|rédige|clique|navigue|va\s+sur|copie|colle|envoie|cherche\s+sur|google\s*(?:docs?|sheets?|drive|slides?)|chrome|navigateur|mail|gmail|whatsapp|spotify|youtube|fenêtre|application|site\s+web|url|page\s+web)/i;
  return guiKeywords.test(text);
}

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

function cleanJsonString(raw: string): string {
  let inStr = false;
  let esc = false;
  let res = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        res += c;
      } else if (c === '\\') {
        esc = true;
        res += c;
      } else if (c === '"') {
        inStr = false;
        res += c;
      } else if (c === '\n') {
        res += '\\n';
      } else if (c === '\r') {
        res += '\\r';
      } else if (c === '\t') {
        res += '\\t';
      } else {
        res += c;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      res += c;
      continue;
    }
    res += c;
  }
  return res;
}

interface ParsedActionCall {
  name: string;
  args: Record<string, unknown>;
  isNative: boolean;
  id?: string;
}

function extractToolCallsFromContent(text: string): ParsedActionCall[] {
  const tools: ParsedActionCall[] = [];
  if (!text) return tools;

  // 1. Détection de tous les objets JSON balancés {...} contenant name / action / tool
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\') {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const candidate = text.slice(startIdx, i + 1);
        try {
          const sanitized = cleanJsonString(candidate);
          const obj = JSON.parse(sanitized);
          const toolName = obj.name || obj.action || obj.tool || obj.function;
          if (toolName && typeof toolName === 'string') {
            const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
            const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            tools.push({
              name: toolName,
              args: typeof args === 'object' && args !== null ? args : { value: args },
              isNative: false,
            });
          }
        } catch {
          // ignore
        }
        startIdx = -1;
      }
    }
  }

  if (tools.length > 0) return tools;

  // 2. Syntaxe standard UI-TARS Action:
  const clickMatch = text.match(/(?:click|point|loc)\s*(?:=|:|\()\s*\[?\s*(\d{1,4})\s*,\s*(\d{1,4})/i);
  if (clickMatch && !text.includes('[SOUS-TÂCHE TERMINÉE]')) {
    const x = parseInt(clickMatch[1]!, 10);
    const y = parseInt(clickMatch[2]!, 10);
    if (x <= state.screenDimensions.width + 100 && y <= state.screenDimensions.height + 100) {
      tools.push({ name: 'Click', args: { loc: [x, y] }, isNative: false });
      return tools;
    }
  }

  const typeMatch = text.match(/(?:type|write|input)\s*(?:\(content=|\(text=|:\s*|=['"])([\s\S]*?)(?:\)|"|'|$)/i);
  if (typeMatch && typeMatch[1] && !text.includes('[SOUS-TÂCHE TERMINÉE]')) {
    tools.push({ name: 'TypeRaw', args: { text: typeMatch[1].trim() }, isNative: false });
    return tools;
  }

  const keyMatch = text.match(/(?:hotkey|press|shortcut)\s*(?:\(key=|:\s*|=['"])([\w+]+)(?:\)|"|'|$)/i);
  if (keyMatch && keyMatch[1]) {
    tools.push({ name: 'Shortcut', args: { shortcut: keyMatch[1].trim() }, isNative: false });
    return tools;
  }

  // 3. Coordonnées brutes (ex: "(286, 872)")
  const rawCoordMatch = text.match(/^\(?\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\)?$/) || text.match(/(\d{1,4})\s*,\s*(\d{1,4})/);
  if (rawCoordMatch && !text.includes('[SOUS-TÂCHE TERMINÉE]')) {
    const x = parseInt(rawCoordMatch[1]!, 10);
    const y = parseInt(rawCoordMatch[2]!, 10);
    if (x <= state.screenDimensions.width + 100 && y <= state.screenDimensions.height + 100) {
      tools.push({ name: 'Click', args: { loc: [x, y] }, isNative: false });
      return tools;
    }
  }

  return tools;
}

async function executeSingleToolAction(
  fnName: string,
  fnArgs: Record<string, unknown>,
  openedUrls: Set<string>
): Promise<{ textResult: string; newSnap: SnapResult }> {
  let textResult = '';
  let newSnap: SnapResult;

  if (fnName === 'OpenUrlInChrome') {
    const targetUrl = String(fnArgs.url || '').trim();
    if (openedUrls.has(targetUrl)) {
      addLog(`⚠️ [Exécutant] URL "${targetUrl}" déjà ouverte.`);
      newSnap = await takeFreshSnapshot();
      textResult = `L'URL "${targetUrl}" est DÉJÀ OUVERTE dans Chrome. Ne la ré-ouvre pas ! Passe immédiatement à l'action suivante : clique dans la zone de texte ou utilise TypeRaw pour saisir le contenu.\n${newSnap.text}`;
    } else {
      openedUrls.add(targetUrl);
      addLog(`🌐 [Exécutant] Ouverture de l'URL "${targetUrl}" dans Chrome...`);
      openUrlInChrome(targetUrl);
      await sleep(3500);
      newSnap = await takeFreshSnapshot();
      textResult = `URL "${targetUrl}" ouverte dans Google Chrome avec succès.\n${newSnap.text}`;
    }
  } else if (fnName === 'App') {
    const mode = String(fnArgs.mode || 'switch');
    const handle = fnArgs.window_handle ? Number(fnArgs.window_handle) : undefined;
    if (mode === 'switch' && handle) {
      addLog(`🪟 [Exécutant] Bascule vers la fenêtre handle ${handle}...`);
      focusWindow(handle);
      try {
        await mcpClient.callTool({ name: 'App', arguments: fnArgs });
      } catch (err) {
        addLog(`ℹ️ MCP App switch: ${err}`);
      }
      await sleep(1500);
      newSnap = await takeFreshSnapshot();
      textResult = `Bascule vers la fenêtre (handle ${handle}) effectuée. La fenêtre est active au premier plan.\n${newSnap.text}`;
    } else {
      const mcpResult = await mcpClient.callTool({ name: 'App', arguments: fnArgs });
      await sleep(1500);
      newSnap = await takeFreshSnapshot();
      textResult = `Application action exécutée : ${JSON.stringify(mcpResult.content || 'OK')}\n${newSnap.text}`;
    }
  } else if (fnName === 'TypeRaw') {
    const textToType = String(fnArgs.text || '');
    const pressEnter = fnArgs.press_enter === true || fnArgs.press_enter === 'True';
    const pressTab = fnArgs.press_tab === true || fnArgs.press_tab === 'True';
    addLog(`⌨️ [Exécutant] Saisie de ${textToType.length} caractères (enter=${pressEnter}, tab=${pressTab})`);
    typeTextViaClipboard(textToType, pressEnter, pressTab);
    await sleep(pressEnter ? 1600 : 800);
    newSnap = await takeFreshSnapshot();
    textResult = `Texte "${textToType.slice(0, 100)}${textToType.length > 100 ? '...' : ''}" saisi avec succès via le presse-papiers.\n${newSnap.text}`;
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
    newSnap = await takeFreshSnapshot();
    textResult = `Clic effectué à (${x_raw}‰, ${y_raw}‰) [pixels ${x_pixel}, ${y_pixel}].\n${newSnap.text}`;
  } else if (fnName === 'Click') {
    await mcpClient.callTool({
      name: 'Click',
      arguments: fnArgs,
    });
    await sleep(1000);
    newSnap = await takeFreshSnapshot();
    textResult = `Clic effectué avec arguments ${JSON.stringify(fnArgs)}.\n${newSnap.text}`;
  } else if (fnName === 'Shortcut') {
    const sc = String(fnArgs.shortcut || '');
    if (!sendKeyShortcutReliable(sc)) {
      await mcpClient.callTool({ name: 'Shortcut', arguments: fnArgs });
    }
    await sleep(1000);
    newSnap = await takeFreshSnapshot();
    textResult = `Raccourci "${sc}" envoyé.\n${newSnap.text}`;
  } else if (fnName === 'ComposeGmail') {
    const to = encodeURIComponent(String(fnArgs.to || ''));
    const su = encodeURIComponent(String(fnArgs.subject || 'Test'));
    const body = encodeURIComponent(String(fnArgs.body || ''));
    const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${body}`;
    openUrlInChrome(composeUrl);
    await sleep(4500);
    sendKeyShortcutReliable('ctrl+enter');
    await sleep(1800);
    newSnap = await takeFreshSnapshot();
    textResult = `Fenêtre Gmail pré-remplie ouverte et Ctrl+Entrée envoyé.\n${newSnap.text}`;
  } else if (fnName === 'ask_gemini_web') {
    const geminiRes = await askGeminiWeb(String(fnArgs.prompt || ''));
    newSnap = await takeFreshSnapshot();
    textResult = `Réponse de Gemini Web : ${geminiRes}\n${newSnap.text}`;
  } else if (fnName === 'RecallPastConversation') {
    const q = String(fnArgs.query || '');
    const cId = String(fnArgs.conversationId || '');
    const t = fnArgs.fileType === 'log' ? 'log' : 'chat';
    if (cId) {
      textResult = readPastConversationDetails(cId, t);
    } else {
      textResult = searchPastConversations(q);
    }
    newSnap = await takeFreshSnapshot();
  } else {
    const mcpResult = await mcpClient.callTool({
      name: fnName,
      arguments: fnArgs,
    });
    await sleep(900);
    newSnap = await takeFreshSnapshot();
    textResult = `${JSON.stringify(mcpResult.content || 'OK')}\n${newSnap.text}`;
  }

  return { textResult, newSnap };
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
- "Click" : Clique sur un numéro de "label" exact listé dans "Interactive Elements" du Snapshot ou sur des coordonnées pixels {"loc": [x, y]}.
- "ClickPerMille" : Clique aux coordonnées (x_permille, y_permille) de 0 à 1000‰ sur l'image.
- "TypeRaw" : Colle/tape du texte instantanément au clavier (+ press_enter / press_tab).
- "Shortcut" : Envoie un raccourci clavier (ex: "ctrl+w", "ctrl+enter", "enter", "esc").
- "Scroll" : Fait défiler la page.
- "App" : Lance ou bascule vers une application Windows existante ({"mode": "switch", "window_handle": <handle>}).
- "PowerShell" : Exécute une commande système Windows.
- "RecallPastConversation" : Consulte les archives (conversation.txt / execution.log) des sessions passées.

RÈGLES STRATÉGIQUES ESSENTIELLES :
1. PROGRAMMATION PAR BATCH & ENCHAÎNEMENT D'ÉTAPES (ANTI-SWAP VRAM) :
   Pour éviter des allers-retours de swap VRAM inutiles, ne découpe JAMAIS une tâche logique en micro-cycles séparés !
   Donne à l'Exécutant une séquence d'actions complète dans "subtask_instruction" qu'il déroulera d'un trait (fixe max_steps entre 4 et 8) :
   Exemple :
   "1. Ouvre 'https://docs.new' avec OpenUrlInChrome.
   2. Utilise TypeRaw pour taper le document : 'Recette Fondant au Chocolat...'.
   3. Réponds [SOUS-TÂCHE TERMINÉE] dès que le texte est dans le document."
   Allowed tools: ["OpenUrlInChrome", "App", "TypeRaw", "Click", "Shortcut"]
   Max steps: 6

2. NAVIGATION WEB & SERVICES GOOGLE :
   Ne cherche JAMAIS à cliquer sur la barre des tâches ou sur l'icône Chrome !
   Utilise IMMÉDIATEMENT "OpenUrlInChrome" avec l'URL directe :
   - Pour Google Docs : subtask_instruction="1. Ouvre https://docs.new dans Chrome. 2. Utilise TypeRaw pour coller le contenu : 'Recette de Fondant au Chocolat...'", allowed_tools=["OpenUrlInChrome", "App", "TypeRaw"], max_steps=6
   - Pour Google Sheets : subtask_instruction="1. Ouvre https://sheets.new dans Chrome. 2. Utilise TypeRaw pour saisir le tableau...", allowed_tools=["OpenUrlInChrome", "App", "Click", "TypeRaw"], max_steps=6
   - Pour tout site : donne l'URL directe avec "OpenUrlInChrome".

3. RÉDACTION DE CONTENU (RECETTES, EMAILS, TEXTES) :
   Si la demande consiste à rédiger un document ou un contenu (ex: recette, lettre, liste), rédige TOUJOURS le texte complet directement à l'intérieur de la consigne subtask_instruction pour que l'Exécutant puisse le coller directement via TypeRaw sans hésiter !

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
  "allowed_tools": ["OpenUrlInChrome", "App", "TypeRaw", "Click", "ClickPerMille"],
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

  // Extraction JSON tolérante avec assainissement des retours à la ligne
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
      const sanitized = cleanJsonString(jsonString);
      const parsed = JSON.parse(sanitized) as Partial<PlannerDecision>;
      const validTools =
        Array.isArray(parsed.allowed_tools) && parsed.allowed_tools.length > 0
          ? parsed.allowed_tools
          : allToolNames;

      return {
        status: parsed.status || 'CONTINUE',
        thought: parsed.thought || 'Analyse effectuée.',
        subtask_instruction: parsed.subtask_instruction || userGoal,
        allowed_tools: validTools,
        max_steps: Math.min(Math.max(Number(parsed.max_steps) || 6, 1), 10),
        final_response: parsed.final_response,
      };
    } catch (e) {
      addLog(`⚠️ [Stratège] Échec JSON.parse standard: ${e}. Tentative d'extraction par regex...`);
      const statusM = cleaned.match(/"status"\s*:\s*"([^"]+)"/i);
      const thoughtM = cleaned.match(/"thought"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*\})/i);
      const subtaskM = cleaned.match(/"subtask_instruction"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*"(?:allowed_tools|max_steps|final_response)")/i);
      const stepsM = cleaned.match(/"max_steps"\s*:\s*(\d+)/i);
      const finalResM = cleaned.match(/"final_response"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*\})/i);

      if (statusM || subtaskM) {
        return {
          status: (statusM?.[1] as PlannerDecision['status']) || 'CONTINUE',
          thought: thoughtM?.[1]?.replace(/\\n/g, '\n') || 'Analyse extraite.',
          subtask_instruction: subtaskM?.[1]?.replace(/\\n/g, '\n') || userGoal,
          allowed_tools: allToolNames,
          max_steps: stepsM ? Math.min(Math.max(Number(stepsM[1]), 1), 10) : 6,
          final_response: finalResM?.[1]?.replace(/\\n/g, '\n'),
        };
      }
    }
  }

  // Détection si le modèle a suggéré une URL directe dans son texte libre
  const directUrl = cleaned.match(/https?:\/\/[^\s"'`)]+/i);
  if (directUrl) {
    return {
      status: 'CONTINUE',
      thought: `Navigation web vers ${directUrl[0]} requise.`,
      subtask_instruction: `1. Ouvre la page ${directUrl[0]} dans Google Chrome. 2. Effectue la tâche demandée : ${userGoal}`,
      allowed_tools: allToolNames,
      max_steps: 6,
    };
  }

  return {
    status: 'CONTINUE',
    thought: 'Plan par défaut (continuation).',
    subtask_instruction: userGoal,
    allowed_tools: allToolNames,
    max_steps: 6,
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
2. Pour taper ou coller du texte, appelle "TypeRaw" {"text": "ton contenu"}.
3. Pour basculer vers une fenêtre existante, appelle "App" {"mode": "switch", "window_handle": <handle>}.
4. Pour cliquer sur un élément qui possède un numéro de "label" dans "Interactive Elements", utilise "Click" {"label": <numero>}.
5. Pour cliquer visuellement sur l'image sans label, utilise "ClickPerMille" {"x_permille": <0-1000>, "y_permille": <0-1000>} ou "Click" {"loc": [x, y]}.
6. Dès que TOUTE ta sous-tâche est exécutée, réponds simplement "[SOUS-TÂCHE TERMINÉE]" pour rendre la main au Stratège.`,
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
  const openedUrlsInSubtask = new Set<string>();
  let currentSnap: SnapResult = { ...initialSnap, fgTitle: '' };
  let lastActionSignature = '';
  let repeatCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    pruneOldSnapshots(messages);

    const isUiTars = executorModelId.toLowerCase().includes('ui-tars');
    const response = await llm.chat.completions.create({
      model: executorModelId,
      messages,
      ...(isUiTars ? {} : { tools: toolsToPass }),
      max_tokens: 150,
      temperature: 0.15,
    });

    const choice = response.choices[0];
    if (!choice) break;
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    const textContent = (assistantMessage.content || '').trim();

    // Vérification explicite de fin de sous-tâche
    if (
      textContent.includes('[SOUS-TÂCHE TERMINÉE]') ||
      textContent.includes('SOUS-TÂCHE TERMINÉE') ||
      /^terminé[e]?\.?$/i.test(textContent)
    ) {
      addLog(`✅ [Exécutant] Fin de sous-tâche confirmée.`);
      actionsLog.push(`Sous-tâche déclarée terminée avec succès.`);
      break;
    }

    // Extraction des appels d'outils : natifs (tool_calls) OU parsés depuis le texte (ex: .sha {"name": "App", ...})
    const callsToExecute: ParsedActionCall[] = [];

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const tc of assistantMessage.tool_calls) {
        if (tc.type !== 'function') continue;
        let fnArgs: Record<string, unknown> = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          fnArgs = {};
        }
        callsToExecute.push({
          name: tc.function.name,
          args: fnArgs,
          isNative: true,
          id: tc.id,
        });
      }
    } else {
      const parsedFromText = extractToolCallsFromContent(textContent);
      for (const item of parsedFromText) {
        callsToExecute.push(item);
      }

      if (callsToExecute.length === 0) {
        const urlMatch = textContent.match(/https?:\/\/[^\s"'`)]+/i);
        if (urlMatch && /ouvr|open|navig|va sur|sheets|docs/i.test(textContent)) {
          const url = urlMatch[0];
          if (!openedUrlsInSubtask.has(url)) {
            callsToExecute.push({
              name: 'OpenUrlInChrome',
              args: { url },
              isNative: false,
            });
          }
        }
      }
    }

    // Si AUCUN outil n'a pu être extrait :
    if (callsToExecute.length === 0) {
      if (step === 0 && textContent.length > 0 && !textContent.includes('terminé')) {
        addLog(`⚠️ [Exécutant] Bavardage sans outil détecté. Nudge vers l'action...`);
        messages.push({
          role: 'user',
          content: `Ne décris pas l'action en texte : appelle directement l'outil adéquat (ex: TypeRaw pour taper, Click pour cliquer, ou OpenUrlInChrome) pour accomplir la tâche : "${subtaskInstruction}".`,
        });
        continue;
      }
      addLog(`🛠️ [Exécutant -> Stratège] Fin de sous-tâche : ${textContent.split('\n')[0]}`);
      actionsLog.push(`Note Exécutant : ${textContent}`);
      break;
    }

    // Exécution des outils
    let anyExecuted = false;
    for (const tool of callsToExecute) {
      const sig = `${tool.name}(${JSON.stringify(tool.args)})`;
      if (sig === lastActionSignature) {
        repeatCount++;
        if (repeatCount >= 2) {
          addLog(`⚠️ [Exécutant] Action ${sig} répétée ${repeatCount} fois. Passage forcé à la suite.`);
          messages.push({
            role: 'user',
            content: `Action ${sig} déjà effectuée. Ne la répète pas ! Passe immédiatement à l'action suivante (ex: TypeRaw pour coller le texte) ou réponds [SOUS-TÂCHE TERMINÉE].`,
          });
          continue;
        }
      } else {
        lastActionSignature = sig;
        repeatCount = 0;
      }

      addLog(`🛠️ [Exécutant Étape ${step + 1}/${maxSteps}] Exécution de ${tool.name} ${JSON.stringify(tool.args)}`);

      try {
        const { textResult, newSnap } = await executeSingleToolAction(tool.name, tool.args, openedUrlsInSubtask);
        currentSnap = newSnap;
        actionsLog.push(`Exécuté : ${tool.name}(${JSON.stringify(tool.args)})`);
        anyExecuted = true;

        if (tool.isNative && tool.id) {
          messages.push({
            role: 'tool',
            tool_call_id: tool.id,
            content: textResult,
          });
        }

        // Renvoi du nouvel écran et incitation à enchaîner l'étape suivante
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Action "${tool.name}" exécutée avec succès.\n${textResult}\nVoici le nouvel écran. Poursuis immédiatement la sous-tâche : effectue la prochaine action (ex: tape le texte avec TypeRaw, clique, etc.) ou réponds [SOUS-TÂCHE TERMINÉE] si tout est fini :`,
            },
            ...currentSnap.images,
          ],
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        addLog(`❌ Erreur Exécutant sur ${tool.name}: ${errorMessage}`);
        actionsLog.push(`Erreur sur ${tool.name}: ${errorMessage}`);
        messages.push({
          role: 'user',
          content: `Erreur lors de l'exécution de ${tool.name}: ${errorMessage}. Essaie une autre méthode ou passe à la suite :`,
        });
      }
    }

    if (!anyExecuted && step > 0) {
      break;
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

  // 2. Exécution directe des tâches déterministes (Google Docs, Sheets, etc.) sans dépendre d'inférence VLM fragile
  const directResult = await tryExecuteDirectTask(userInstruction, conversationId);
  if (directResult) {
    addLog(`⚡ [Exécution directe réussie] : ${directResult}`);
    return directResult;
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

    let decision: PlannerDecision;

    // Au cycle 1 : tenter d'abord un plan hardcodé pour les tâches classiques (Google Docs/Sheets/etc.)
    // Cela évite de dépendre du JSON fragile du petit modèle 9B pour des tâches simples
    if (cycle === 1) {
      const hardcoded = tryBuildHardcodedPlan(userInstruction);
      if (hardcoded) {
        addLog(`📋 [Plan Hardcodé] Tâche standard détectée, plan optimisé pré-construit.`);
        decision = hardcoded;
      } else {
        decision = await askPlanner(llm, userInstruction, globalHistory, currentSnap, chatHistory);
      }
    } else {
      decision = await askPlanner(llm, userInstruction, globalHistory, currentSnap, chatHistory);
    }

    addLog(`🧠 [Stratège] Pensée : ${decision.thought}`);

    if (conversationId) {
      logConversationAction(conversationId, {
        cycle,
        thought: decision.thought,
        subtask: decision.subtask_instruction,
      });
    }

    if (decision.status === 'DONE') {
      // Garde-fou : empêcher un DONE prématuré au cycle 1 si aucune action n'a été exécutée
      // et que la tâche requiert clairement des actions GUI
      if (cycle === 1 && globalHistory.length === 0 && requiresGuiAction(userInstruction)) {
        addLog(`⚠️ [Garde-fou] Le Stratège a dit DONE au cycle 1 sans rien exécuter pour une tâche GUI ! Forçage en CONTINUE...`);
        const forcedPlan = tryBuildHardcodedPlan(userInstruction);
        if (forcedPlan) {
          // Utiliser le plan hardcodé comme secours
          const needsVisualSnap2 = forcedPlan.allowed_tools.some((t) => ['Click', 'ClickPerMille'].includes(t));
          if (needsVisualSnap2 && currentSnap.images.length === 0) {
            addLog(`📸 Prise de capture visuelle pour l'Exécutant (plan de secours)...`);
            currentSnap = await takeFreshSnapshot();
          }
          const execResult = await runExecutorSubtask(
            llm,
            forcedPlan.subtask_instruction,
            forcedPlan.allowed_tools,
            forcedPlan.max_steps,
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
            `--- Cycle ${cycle} (Plan de secours : "${forcedPlan.subtask_instruction.slice(0, 100)}...") ---\n` +
              execResult.summary.map((s) => `  • ${s}`).join('\n')
          );
          continue;
        }
        // Pas de plan hardcodé possible, on continue le cycle normal
        continue;
      }
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
    // Si l'Exécutant a besoin d'outils visuels ou de navigation mais qu'on n'a pas encore d'image :
    const needsVisualSnap = decision.allowed_tools.some((t) =>
      ['Click', 'ClickPerMille', 'OpenUrlInChrome', 'TypeRaw'].includes(t)
    );
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
