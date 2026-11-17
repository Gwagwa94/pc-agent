import fs from 'fs';
import path from 'path';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ConversationMetadata {
  id: string;
  title: string;
  folderName: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  snapshotCount: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  folderName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  snapshotCount: number;
}

const CONV_BASE_DIR = path.join(process.cwd(), 'conversations');

export function initConversationsSystem(): void {
  if (!fs.existsSync(CONV_BASE_DIR)) {
    fs.mkdirSync(CONV_BASE_DIR, { recursive: true });
  }
}

export function getConversationDir(id: string): string {
  initConversationsSystem();
  const cleanId = path.basename(id);
  return path.join(CONV_BASE_DIR, cleanId);
}

function updateGlobalIndex(): void {
  initConversationsSystem();
  try {
    const list = listConversations();
    const indexPath = path.join(CONV_BASE_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

export function createConversation(title = 'Nouvelle discussion'): ConversationMetadata {
  initConversationsSystem();
  const now = Date.now();
  const d = new Date(now);
  const dateTag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(
    2,
    '0'
  )}${String(d.getSeconds()).padStart(2, '0')}`;
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  const id = `conv_${dateTag}_${randomSuffix}`;

  const convDir = path.join(CONV_BASE_DIR, id);
  const snapDir = path.join(convDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const metadata: ConversationMetadata = {
    id,
    title,
    folderName: id,
    createdAt: now,
    updatedAt: now,
    messages: [],
    snapshotCount: 0,
  };

  // 1. Sauvegarde metadata.json
  const metaPath = path.join(convDir, 'metadata.json');
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

  // 2. Initialisation conversation.txt
  const dateStr = d.toLocaleString('fr-FR');
  const initialTxt = `============================================================\n` +
    `DISCUSSION : ${title}\n` +
    `IDENTIFIANT: ${id}\n` +
    `CRÉÉE LE   : ${dateStr}\n` +
    `DOSSIER    : ${convDir}\n` +
    `============================================================\n\n`;
  fs.writeFileSync(path.join(convDir, 'conversation.txt'), initialTxt, 'utf8');

  // 3. Initialisation execution.log
  const initialLog = `=== JOURNAL DES RÉFLEXIONS & ACTIONS - ${id} ===\n` +
    `Débutée le : ${dateStr}\n\n`;
  fs.writeFileSync(path.join(convDir, 'execution.log'), initialLog, 'utf8');

  updateGlobalIndex();
  return metadata;
}

export function getConversation(id: string): ConversationMetadata | null {
  const convDir = getConversationDir(id);
  const metaPath = path.join(convDir, 'metadata.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    return JSON.parse(raw) as ConversationMetadata;
  } catch {
    return null;
  }
}

export function listConversations(): ConversationSummary[] {
  initConversationsSystem();
  try {
    const entries = fs.readdirSync(CONV_BASE_DIR, { withFileTypes: true });
    const summaries: ConversationSummary[] = [];

    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const metaPath = path.join(CONV_BASE_DIR, ent.name, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(raw) as ConversationMetadata;
          summaries.push({
            id: meta.id,
            title: meta.title || 'Discussion sans titre',
            folderName: meta.folderName || ent.name,
            createdAt: meta.createdAt || 0,
            updatedAt: meta.updatedAt || meta.createdAt || 0,
            messageCount: meta.messages?.length || 0,
            snapshotCount: meta.snapshotCount || 0,
          });
        } catch {
          // ignore invalid metadata
        }
      }
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function addMessageToConversation(
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string
): ConversationMetadata {
  let conv = getConversation(id);
  if (!conv) {
    conv = createConversation(content.slice(0, 36));
  }

  const now = Date.now();
  const msgId = `msg_${now}_${Math.random().toString(36).slice(2, 6)}`;
  conv.messages.push({
    id: msgId,
    role,
    content,
    timestamp: now,
  });
  conv.updatedAt = now;

  // Mise à jour du titre si c'est le 1er message utilisateur
  if (role === 'user' && (conv.title === 'Nouvelle discussion' || !conv.title)) {
    conv.title = content.trim().slice(0, 36) + (content.length > 36 ? '…' : '');
  }

  const convDir = getConversationDir(conv.id);

  // 1. Sauvegarde metadata.json
  fs.writeFileSync(path.join(convDir, 'metadata.json'), JSON.stringify(conv, null, 2), 'utf8');

  // 2. Append dans conversation.txt
  const time = new Date(now).toLocaleTimeString('fr-FR');
  const sender =
    role === 'user' ? 'Grégoire' : role === 'assistant' ? 'PC Agent' : 'Système';
  const txtEntry = `[${time}] ${sender} :\n${content}\n\n------------------------------------------------------------\n\n`;
  fs.appendFileSync(path.join(convDir, 'conversation.txt'), txtEntry, 'utf8');

  updateGlobalIndex();
  return conv;
}

export function logConversationAction(
  id: string,
  entry: {
    cycle?: number;
    thought?: string;
    subtask?: string;
    action?: string;
    result?: string;
  }
): void {
  const convDir = getConversationDir(id);
  if (!fs.existsSync(convDir)) return;

  const logPath = path.join(convDir, 'execution.log');
  const time = new Date().toLocaleTimeString('fr-FR');
  let text = `[${time}]`;
  if (entry.cycle) text += ` [CYCLE ${entry.cycle}]`;
  text += `\n`;

  if (entry.thought) text += `  🧠 Pensée Stratège  : ${entry.thought}\n`;
  if (entry.subtask) text += `  🎯 Sous-tâche assignée : ${entry.subtask}\n`;
  if (entry.action)  text += `  🛠️ Action Exécutant   : ${entry.action}\n`;
  if (entry.result)  text += `  📄 Résultat retourné  : ${entry.result.slice(0, 300)}\n`;
  text += `------------------------------------------------------------\n`;

  fs.appendFileSync(logPath, text, 'utf8');
}

export function saveConversationSnapshot(
  id: string,
  cycle: number,
  label: string,
  imgFhdBuffer: Buffer
): string | null {
  const convDir = getConversationDir(id);
  if (!fs.existsSync(convDir)) return null;

  const snapDir = path.join(convDir, 'snapshots');
  if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

  const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${String(cycle).padStart(2, '0')}_${cleanLabel}_${Date.now()}.png`;
  const filePath = path.join(snapDir, filename);

  try {
    fs.writeFileSync(filePath, imgFhdBuffer);

    // Mettre à jour snapshotCount
    const conv = getConversation(id);
    if (conv) {
      conv.snapshotCount = (conv.snapshotCount || 0) + 1;
      fs.writeFileSync(path.join(convDir, 'metadata.json'), JSON.stringify(conv, null, 2), 'utf8');
      updateGlobalIndex();
    }
    return filename;
  } catch {
    return null;
  }
}

export function deleteConversation(id: string): boolean {
  initConversationsSystem();
  const convDir = getConversationDir(id);
  if (fs.existsSync(convDir)) {
    try {
      fs.rmSync(convDir, { recursive: true, force: true });
      updateGlobalIndex();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function searchPastConversations(query: string): string {
  const list = listConversations();
  if (list.length === 0) return 'Aucune discussion enregistrée pour le moment.';

  const q = query.toLowerCase().trim();
  const matches: string[] = [];

  for (const item of list.slice(0, 15)) {
    const convDir = getConversationDir(item.id);
    const txtPath = path.join(convDir, 'conversation.txt');
    if (fs.existsSync(txtPath)) {
      const content = fs.readFileSync(txtPath, 'utf8');
      if (!q || content.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)) {
        matches.push(
          `📁 [${item.id}] "${item.title}" (${new Date(item.updatedAt).toLocaleString('fr-FR')})`
        );
      }
    }
  }

  if (matches.length === 0) {
    return (
      `Aucune discussion ne contient le terme "${query}". Dernières discussions disponibles :\n` +
      list
        .slice(0, 5)
        .map((c) => `- [${c.id}] "${c.title}"`)
        .join('\n')
    );
  }

  return `Discussions correspondantes trouvées :\n` + matches.join('\n');
}

export function readPastConversationDetails(convId: string, type: 'chat' | 'log' = 'chat'): string {
  const convDir = getConversationDir(convId);
  const targetFile = type === 'log' ? 'execution.log' : 'conversation.txt';
  const filePath = path.join(convDir, targetFile);

  if (!fs.existsSync(filePath)) {
    return `Fichier ${targetFile} introuvable pour la discussion "${convId}".`;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.length > 2500) {
    return `... [Début tronqué]\n` + content.slice(-2500);
  }
  return content;
}
