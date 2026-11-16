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
const PORT         = Number(process.env.GATEWAY_PORT)    || 8080;
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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'sessions');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.HTTPS === 'true',   // set HTTPS=true when behind TLS terminator (Caddy)
      maxAge: 7 * 24 * 60 * 60 * 1000,       // 7 days
    },
  })
);

// ── Auth helpers ─────────────────────────────────────────────────────────────
declare module 'express-session' {
  interface SessionData { authenticated: boolean }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAuthPage(req: Request, res: Response, next: NextFunction) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

// ── Proxy helper ─────────────────────────────────────────────────────────────
async function proxyToAgent(
  method: string,
  agentPath: string,
  body?: unknown
): Promise<{ status: number; contentType: string; data: Buffer }> {
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

  const res = await fetch(`${PC_AGENT_URL}${agentPath}`, fetchOptions as Parameters<typeof fetch>[1]);

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType, data };
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
  const { username, password } = req.body as { username: string; password: string };
  if (username === USERNAME && await bcrypt.compare(password, PASS_HASH)) {
    req.session.authenticated = true;
    req.session.save(() => res.redirect('/'));
  } else {
    res.redirect('/login?error=1');
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Dashboard (self-contained SPA)
app.get('/', requireAuthPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
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

app.post('/api/command', requireAuth, async (req, res) => {
  const { instruction } = req.body as { instruction?: string };
  if (!instruction?.trim()) {
    return res.status(400).json({ error: 'Paramètre "instruction" manquant' });
  }
  try {
    const { status, contentType, data } = await proxyToAgent('POST', '/command', { instruction });
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
