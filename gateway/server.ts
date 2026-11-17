// ============================================================================
// PC-AGENT GATEWAY — Authenticated reverse-proxy for the Dual-Brain agent
// Deploy on the VPS (10.7.0.1). Proxies to the PC at PC_AGENT_URL.
// ============================================================================
import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sessionFileStore from 'session-file-store';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT         = Number(process.env.GATEWAY_PORT)    || 14000;
const USERNAME     = process.env.GATEWAY_USER            || 'admin';
const PASS_HASH    = process.env.GATEWAY_PASS_HASH        || '';  // bcrypt hash
const SESSION_SEC  = process.env.SESSION_SECRET           || 'change-me-in-production';
const PC_AGENT_URL = process.env.PC_AGENT_URL             || 'http://10.7.0.2:2999';
const API_SECRET   = process.env.API_SECRET               || '';  // sent to PC agent

if (!PASS_HASH) {
  console.error('❌  GATEWAY_PASS_HASH is not set in .env  — run: node -e "import(\'bcryptjs\').then(b=>b.default.hash(\'YOUR_PASSWORD\',12).then(console.log))"');
  process.exit(1);
}

// ── Session store (FileStore — survives server & container restarts) ──────────
const FileStore = sessionFileStore(session);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'sessions');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function resolveDashboardPath(): string {
  const direct = path.join(__dirname, 'dashboard.html');
  if (fs.existsSync(direct)) return direct;
  const parent = path.join(__dirname, '..', 'dashboard.html');
  if (fs.existsSync(parent)) return parent;
  return path.join(process.cwd(), 'dashboard.html');
}

const app = express();

// Trust reverse proxy (Caddy / Nginx) so HTTPS cookie forwarding works
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new FileStore({
      path: DATA_DIR,
      ttl: 7 * 24 * 60 * 60, // 7 days in seconds
      retries: 1,
      logFn: () => {},       // quiet
    }),
    secret: SESSION_SEC,
    resave: false,
    saveUninitialized: false,
    proxy: true,                             // Trust reverse proxy for X-Forwarded-Proto
    cookie: {
      httpOnly: true,
      sameSite: 'lax',                       // 'lax' allows cookie preservation across 302 redirects
      secure: 'auto',                        // 'auto' detects HTTPS automatically (works on https://domain and http://IP:14000)
      maxAge: 7 * 24 * 60 * 60 * 1000,       // 7 days
    },
  })
);

// ── Request Logger & Debug Middleware ───────────────────────────────────────
app.use((req, _res, next) => {
  const sid = req.sessionID ? req.sessionID.slice(0, 8) : 'none';
  const authState = req.session?.authenticated ? '✅ Auth' : '❌ Guest';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  console.log(`📡 [${req.method}] ${req.url} | Session: ${sid} (${authState}) | Proto: ${proto} | Host: ${req.headers.host || 'unknown'}`);
  next();
});

// ── Auth helpers ─────────────────────────────────────────────────────────────
declare module 'express-session' {
  interface SessionData { authenticated: boolean }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.authenticated) return next();
  console.log(`⛔ [API 401] ${req.method} ${req.url} -> Accès refusé (non authentifié)`);
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAuthPage(req: Request, res: Response, next: NextFunction) {
  if (req.session?.authenticated) return next();
  console.log(`🛑 [AUTH] Redirection vers /login pour ${req.url} (Pas de session active)`);
  res.redirect('/login');
}

// ── Proxy helper ─────────────────────────────────────────────────────────────
async function proxyToAgent(
  method: string,
  agentPath: string,
  body?: unknown
): Promise<{ status: number; contentType: string; data: Buffer }> {
  const target = `${PC_AGENT_URL}${agentPath}`;
  const start = Date.now();
  const isStatusPing = agentPath.startsWith('/status');
  if (!isStatusPing) {
    console.log(`➡️  [PROXY ${method}] Envoi vers PC Agent : ${target}`);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (API_SECRET) headers['X-Agent-Secret'] = API_SECRET;

  const fetchOptions: Record<string, unknown> = {
    method,
    headers,
  };
  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(target, fetchOptions as Parameters<typeof fetch>[1]);
    const ms = Date.now() - start;
    if (!isStatusPing) {
      console.log(`⬅️  [PROXY ${method}] Réponse reçue de ${agentPath} -> HTTP ${res.status} (${ms}ms)`);
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType, data };
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`💥 [PROXY ERREUR] Impossible de joindre le PC Agent sur ${target} (${ms}ms) : ${msg}`);
    throw err;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Login page
app.get('/login', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PC Agent — Connexion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f1117; font-family: 'Segoe UI', system-ui, sans-serif; color: #e2e8f0;
    }
    .card {
      background: #1a1d2e; border: 1px solid #2d3148; border-radius: 16px;
      padding: 2.5rem 2rem; width: 100%; max-width: 380px;
    }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.4rem; }
    .sub { color: #64748b; font-size: 0.85rem; margin-bottom: 2rem; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.4rem; }
    input {
      width: 100%; padding: 0.65rem 0.9rem; border-radius: 8px;
      border: 1px solid #2d3148; background: #0f1117; color: #e2e8f0;
      font-size: 0.95rem; margin-bottom: 1.2rem; outline: none;
    }
    input:focus { border-color: #6366f1; }
    button {
      width: 100%; padding: 0.75rem; border-radius: 8px; border: none;
      background: #6366f1; color: #fff; font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: background 0.2s;
    }
    button:hover { background: #4f46e5; }
    .error {
      background: #3b1a1a; border: 1px solid #7f1d1d; color: #fca5a5;
      border-radius: 8px; padding: 0.65rem 0.9rem; font-size: 0.85rem; margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 PC Agent</h1>
    <p class="sub">Dual-Brain · Windows 11 · LM Studio</p>
    ${_req.query.error ? '<div class="error">Identifiants incorrects</div>' : ''}
    <form method="POST" action="/login">
      <label>Nom d'utilisateur</label>
      <input type="text" name="username" autocomplete="username" required autofocus>
      <label>Mot de passe</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Se connecter</button>
    </form>
  </div>
</body>
</html>`);
});

// Login handler
app.post('/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  console.log(`🔐 [POST /login] Tentative de connexion avec l'utilisateur: "${username}"`);

  if (!username || !password) {
    console.log(`❌ [LOGIN ÉCHEC] Nom d'utilisateur ou mot de passe manquant dans le corps de requête.`);
    return res.redirect('/login?error=1');
  }

  const userMatches = username.trim().toLowerCase() === USERNAME.trim().toLowerCase();
  const passMatches = await bcrypt.compare(password, PASS_HASH);
  console.log(`🔍 [LOGIN VÉRIF] Utilisateur: ${userMatches ? '✅ OUI' : '❌ NON'} | Mot de passe: ${passMatches ? '✅ OUI' : '❌ NON'}`);

  if (userMatches && passMatches) {
    req.session.authenticated = true;
    req.session.save((err) => {
      if (err) {
        console.error(`💥 [SESSION ERREUR] Erreur de sauvegarde:`, err);
        return res.redirect('/login?error=save');
      }
      console.log(`🎉 [LOGIN SUCCÈS] Session activée (ID: ${req.sessionID}) -> Redirection vers /`);
      res.redirect('/');
    });
  } else {
    console.log(`❌ [LOGIN REJETÉ] Identifiants invalides.`);
    res.redirect('/login?error=1');
  }
});

// Logout
app.post('/logout', (req, res) => {
  console.log(`👋 [LOGOUT] Déconnexion de l'utilisateur (Session: ${req.sessionID})`);
  req.session.destroy(() => res.redirect('/login'));
});

// Dashboard (self-contained SPA)
app.get('/', requireAuthPage, (req, res) => {
  console.log(`🏠 [GET /] Affichage du dashboard pour l'utilisateur authentifié (Session: ${req.sessionID})`);
  res.sendFile(resolveDashboardPath());
});

// ── Diagnostic / Health Check (accessible sans auth pour tester la jonction) ──
app.get('/api/health', async (_req, res) => {
  console.log(`🩺 [HEALTH CHECK] Test de diagnostic demandé`);
  const start = Date.now();
  let pcAgentCheck: Record<string, unknown> = {};

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_SECRET) headers['X-Agent-Secret'] = API_SECRET;
    const response = await fetch(`${PC_AGENT_URL}/status`, { headers } as Parameters<typeof fetch>[1]);
    const ms = Date.now() - start;
    const bodyText = await response.text();
    let jsonBody = null;
    try { jsonBody = JSON.parse(bodyText); } catch { /* ignore */ }

    pcAgentCheck = {
      reachable: true,
      status_code: response.status,
      latency_ms: ms,
      response: jsonBody || bodyText.slice(0, 200),
    };
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    pcAgentCheck = {
      reachable: false,
      latency_ms: ms,
      error: msg,
      hint: "Vérifiez que WireGuard est actif (10.7.0.1 <-> 10.7.0.2) et que 'npx tsx agent.ts' tourne sur le PC Windows.",
    };
  }

  res.json({
    gateway: {
      status: 'online',
      port: PORT,
      configured_user: USERNAME,
      configured_target: PC_AGENT_URL,
      pass_hash_set: Boolean(PASS_HASH),
      api_secret_set: Boolean(API_SECRET),
    },
    pc_agent_link: pcAgentCheck,
  });
});

// ── Authenticated API proxy routes ───────────────────────────────────────────

app.get('/api/status', requireAuth, async (_req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('GET', '/status');
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.get('/api/snapshot.png', requireAuth, async (_req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('GET', '/snapshot.png');
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.get('/api/models', requireAuth, async (_req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('GET', '/models');
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.post('/api/model', requireAuth, async (req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('POST', '/model', req.body);
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

// ── Proxy des Conversations (ChatGPT / Gemini style) ─────────────────────────
app.get('/api/conversations', requireAuth, async (_req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('GET', '/conversations');
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { status, contentType, data } = await proxyToAgent('POST', '/conversations', req.body);
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const { status, contentType, data } = await proxyToAgent('GET', `/conversations/${encodeURIComponent(id)}`);
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const { status, contentType, data } = await proxyToAgent('DELETE', `/conversations/${encodeURIComponent(id)}`);
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

app.post('/api/command', requireAuth, async (req, res) => {
  const { instruction } = req.body as { instruction?: string };
  if (!instruction?.trim()) {
    return res.status(400).json({ error: 'Paramètre "instruction" manquant' });
  }
  try {
    const { status, contentType, data } = await proxyToAgent('POST', '/command', req.body);
    res.status(status).type(contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: 'PC agent unreachable', detail: String(err) });
  }
});

// Session check endpoint (for SPA heartbeat)
app.get('/api/me', (req, res) => {
  if (req.session.authenticated) res.json({ authenticated: true, user: USERNAME });
  else res.status(401).json({ authenticated: false });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 PC-Agent Gateway running on http://0.0.0.0:${PORT}`);
  console.log(`   PC Agent target : ${PC_AGENT_URL}`);
});
