import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

import { state } from './state.js';
import { addLog } from './logger.js';
import { initScreenResolution } from './powershell.js';
import { initMCP } from './mcp.js';
import { runAgentTask } from './brain.js';
import {
  syncLoadedModelAtStartup,
  PLANNER_MODEL,
  EXECUTOR_MODEL,
  setPlannerModel,
  getAvailableLlmModels,
} from './vram.js';
import {
  createConversation,
  getConversation,
  listConversations,
  addMessageToConversation,
  deleteConversation,
  initConversationsSystem,
} from './conversations.js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── CORS (gateway only, or wildcard if no secret configured) ─────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Middleware de log des requêtes entrantes ─────────────────────────────────
app.use((req, _res, next) => {
  // Ne pas polluer les logs avec les pings /status répétitifs si la connexion est active
  if (req.url === '/status' || req.url.startsWith('/status?')) {
    return next();
  }
  addLog(`🌐 [AGENT HTTP ${req.method}] ${req.url} depuis ${req.ip}`);
  next();
});

// ── API_SECRET guard: protect sensitive endpoints from unauthorized callers ───
// If API_SECRET is set in .env, every call to /status, /command, /snapshot.png
// must carry the matching X-Agent-Secret header (sent by the gateway).
const API_SECRET = process.env.API_SECRET || '';

function requireSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  const incoming = req.headers['x-agent-secret'];
  if (!API_SECRET) {
    return next(); // secret non configuré → mode ouvert
  }
  if (incoming === API_SECRET) {
    return next();
  }
  addLog(`⛔ [AUTH REJET] Requête ${req.method} ${req.url} bloquée (Secret reçu: "${incoming ? 'INVALIDE' : 'ABSENT'}").`);
  res.status(403).json({ error: 'Forbidden — invalid API secret' });
}

// Connexion au serveur local LM Studio
const llm = new OpenAI({
  baseURL: process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
});

app.get('/', (_req, res) => {
  const htmlPath = path.join(process.cwd(), 'dashboard.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('Place le fichier dashboard.html dans C:\\Users\\grego\\pc-agent\\');
  }
});

app.get('/status', requireSecret, (_req, res) => {
  const snapPath = path.join(process.cwd(), 'last_snapshot.png');
  res.json({
    busy: state.isAgentBusy,
    screenDimensions: state.screenDimensions,
    logs: state.recentLogs,
    hasSnapshot: fs.existsSync(snapPath),
    snapshotTime: state.lastSnapshotTimestamp,
  });
});

app.get('/snapshot.png', requireSecret, (_req, res) => {
  const snapPath = path.join(process.cwd(), 'last_snapshot.png');
  if (fs.existsSync(snapPath)) {
    res.sendFile(snapPath);
  } else {
    res.status(404).end();
  }
});

app.get('/models', requireSecret, (_req, res) => {
  res.json({
    currentPlanner: PLANNER_MODEL,
    currentExecutor: EXECUTOR_MODEL,
    models: getAvailableLlmModels(),
  });
});

app.post('/model', requireSecret, (req, res) => {
  const { plannerModel } = req.body;
  if (!plannerModel || typeof plannerModel !== 'string') {
    return res.status(400).json({ error: 'Paramètre "plannerModel" manquant' });
  }
  setPlannerModel(plannerModel);
  res.json({ status: 'ok', currentPlanner: PLANNER_MODEL });
});

// ── Gestion des Conversations (ChatGPT / Gemini style) ──────────────────────
app.get('/conversations', requireSecret, (_req, res) => {
  res.json({ conversations: listConversations() });
});

app.post('/conversations', requireSecret, (req, res) => {
  const title = (req.body?.title as string) || 'Nouvelle discussion';
  const conv = createConversation(title);
  res.json(conv);
});

app.get('/conversations/:id', requireSecret, (req, res) => {
  const id = String(req.params.id || '');
  const conv = getConversation(id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation non trouvée' });
  }
  res.json(conv);
});

app.delete('/conversations/:id', requireSecret, (req, res) => {
  const id = String(req.params.id || '');
  const success = deleteConversation(id);
  res.json({ success });
});

app.post('/command', requireSecret, async (req, res) => {
  const { instruction, conversationId } = req.body;
  if (!instruction || typeof instruction !== 'string') {
    return res.status(400).json({ error: 'Paramètre "instruction" manquant' });
  }

  // Si pas d'ID fourni, on crée une nouvelle discussion
  let activeConvId = conversationId as string | undefined;
  if (!activeConvId || !getConversation(activeConvId)) {
    const newConv = createConversation();
    activeConvId = newConv.id;
  }

  // 1. Enregistre le message utilisateur dans la discussion
  addMessageToConversation(activeConvId, 'user', instruction);

  state.isAgentBusy = true;
  addLog(`📩 [${activeConvId}] Nouvel ordre reçu : "${instruction}"`);

  try {
    const result = await runAgentTask(llm, instruction, activeConvId);
    // 2. Enregistre la réponse de l'agent dans la discussion (txt & json)
    addMessageToConversation(activeConvId, 'assistant', result);
    addLog(`✅ [${activeConvId}] Résultat final : ${result.slice(0, 150)}`);
    res.json({ status: 'ok', result, conversationId: activeConvId });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    addLog(`❌ Erreur globale: ${errorMessage}`);
    addMessageToConversation(activeConvId, 'system', `Erreur : ${errorMessage}`);
    res.status(500).json({ status: 'error', error: errorMessage, conversationId: activeConvId });
  } finally {
    state.isAgentBusy = false;
  }
});

initMCP(llm)
  .then(() => {
    initConversationsSystem();
    initScreenResolution();
    syncLoadedModelAtStartup();
    const port = Number(process.env.PORT) || 2999;
    const host = process.env.BIND_HOST || '0.0.0.0';
    app.listen(port, host, () => {
      console.log(`🚀 Interface Web & Agent Dual-Brain disponibles sur http://127.0.0.1:${port}`);
    });
  })
  .catch((err) => {
    console.error('Erreur fatale au démarrage de MCP:', err);
  });
