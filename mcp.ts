import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { addLog } from './logger.js';
import { state } from './state.js';
import { getForegroundWindowTitle } from './powershell.js';
import { PLANNER_MODEL, EXECUTOR_MODEL, PLANNER_CONTEXT_LENGTH, EXECUTOR_CONTEXT_LENGTH } from './vram.js';
import type { SnapResult } from './types.js';

export let mcpClient: Client;
export let allAvailableTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

export function resolveUvxPath(): string {
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\grego';
  const candidates = [
    process.env.UVX_PATH,
    path.join(userProfile, '.local', 'bin', 'uvx.exe'),
    path.join(userProfile, '.cargo', 'bin', 'uvx.exe'),
    'C:\\Users\\grego\\.local\\bin\\uvx.exe',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (fs.existsSync(normalized)) {
      addLog(`✅ uvx.exe trouvé : ${normalized}`);
      return normalized;
    }
  }
  throw new Error(
    `❌ Impossible de trouver uvx.exe ! Lance dans PowerShell : irm https://astral.sh/uv/install.ps1 | iex`
  );
}

export async function takeFreshSnapshot(): Promise<SnapResult> {
  const fgTitle = getForegroundWindowTitle();

  const mcpResult = await mcpClient.callTool({
    name: 'Snapshot',
    arguments: { use_vision: true },
  });

  const textParts: string[] = [];
  if (fgTitle) {
    textParts.push(`📌 FENÊTRE ACTIVE CONFIRMÉE PAR WINDOWS : "${fgTitle}"`);
  }

  const images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
  const contentArray = (mcpResult.content || []) as Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;

  for (const item of contentArray) {
    if (item.type === 'text' && item.text) {
      textParts.push(item.text);
    } else if (item.type === 'image' && item.data) {
      const imgBuffer = Buffer.from(item.data, 'base64');
      if (imgBuffer.length > 24 && imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50) {
        const pngW = imgBuffer.readUInt32BE(16);
        const pngH = imgBuffer.readUInt32BE(20);
        if (pngW > 0 && pngH > 0) {
          state.screenDimensions = { width: pngW, height: pngH };
        }
      }
      fs.writeFileSync(path.join(process.cwd(), 'last_snapshot.png'), imgBuffer);
      state.lastSnapshotTimestamp = Date.now();
      images.push({
        type: 'image_url',
        image_url: {
          url: `data:${item.mimeType || 'image/png'};base64,${item.data}`,
        },
      });
    }
  }

  return {
    text: textParts.join('\n') || 'Snapshot effectué.',
    images,
    fgTitle,
  };
}

export function pruneOldSnapshots(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): void {
  let imageCount = 0;
  let snapshotTextCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j]!;
        if (part.type === 'image_url') {
          imageCount++;
          if (imageCount > 2) {
            msg.content[j] = {
              type: 'text',
              text: "[Ancienne capture d'écran purgée]",
            };
          }
        }
      }
    }

    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (
        msg.content.includes('Interactive Elements') ||
        msg.content.includes('FENÊTRE ACTIVE CONFIRMÉE')
      ) {
        snapshotTextCount++;
        if (snapshotTextCount > 1) {
          msg.content = '[Ancien Snapshot expiré — fie-toi uniquement au dernier Snapshot]';
        }
      }
    }
  }
}

export async function initMCP(llm: OpenAI): Promise<void> {
  addLog('🔌 Démarrage du serveur Windows-MCP (serve)...');
  const uvxExe = resolveUvxPath();

  const envWithUvx: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) envWithUvx[k] = v;
  }
  envWithUvx.PATH = `${path.dirname(uvxExe)};${process.env.PATH || ''}`;
  envWithUvx.PYTHONIOENCODING = 'utf-8';

  const transport = new StdioClientTransport({
    command: uvxExe,
    args: ['windows-mcp', 'serve'],
    env: envWithUvx,
    stderr: 'inherit',
  });

  mcpClient = new Client(
    { name: 'pc-autonomous-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport, { timeout: 180000 });
  const toolsList = await mcpClient.listTools();

  const allowedMcpTools = new Set(['Click', 'Shortcut', 'Scroll', 'App', 'PowerShell']);

  allAvailableTools = toolsList.tools
    .filter((tool) => allowedMcpTools.has(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: (tool.inputSchema as Record<string, unknown>) || {
          type: 'object',
          properties: {},
        },
      },
    }));

  // Ajout des Super-Outils spécialisés
  allAvailableTools.push(
    {
      type: 'function',
      function: {
        name: 'ComposeGmail',
        description:
          "Ouvre directement la fenêtre de rédaction Gmail pré-remplie (destinataire 'to', objet 'subject', corps 'body') et tente d'envoyer.",
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Adresse email du destinataire.' },
            subject: { type: 'string', description: "Objet de l'email." },
            body: { type: 'string', description: "Corps du message de l'email." },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'OpenUrlInChrome',
        description:
          'Ouvre directement une URL complète (ex: https://web.whatsapp.com, https://drive.google.com) dans Google Chrome.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: "L'URL à ouvrir." },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ClickPerMille',
        description:
          "Clique à l'écran avec des coordonnées en POUR MILLE (‰, de 0 à 1000) : x_permille (0=gauche, 1000=droite), y_permille (0=haut, 1000=bas).",
        parameters: {
          type: 'object',
          properties: {
            x_permille: { type: 'number', description: 'Position X en pour mille (0 à 1000).' },
            y_permille: { type: 'number', description: 'Position Y en pour mille (0 à 1000).' },
          },
          required: ['x_permille', 'y_permille'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'TypeRaw',
        description:
          "Colle/tape instantanément du texte là où se trouve le curseur. Supporte press_enter (true/false) et press_tab (true/false).",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Le texte à saisir.' },
            press_enter: { type: 'boolean', description: 'Appuyer sur Entrée après saisie.' },
            press_tab: { type: 'boolean', description: 'Appuyer sur Tab après saisie.' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_gemini_web',
        description:
          'Envoie une question complexe à Google Gemini ouvert dans Chrome et récupère sa réponse.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'La question à poser à Gemini.' },
          },
          required: ['prompt'],
        },
      },
    }
  );

  addLog(`✅ Architecture Dual-Brain prête :`);
  addLog(`   🧠 Stratège (Planner)  : ${PLANNER_MODEL} (contexte : ${PLANNER_CONTEXT_LENGTH} tokens)`);
  addLog(`   🛠️ Exécutant (Executor) : ${EXECUTOR_MODEL} (contexte : ${EXECUTOR_CONTEXT_LENGTH} tokens)`);
}
