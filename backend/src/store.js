// Armazenamento simples das reuniões em arquivo JSON (backend/data/meetings.json).
// Suficiente para um MVP. Para produção, troque por um banco (SQLite/Postgres).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'meetings.json');

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, '[]', 'utf8');
  }
}

async function readAll() {
  await ensureFile();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeAll(meetings) {
  await ensureFile();
  await fs.writeFile(DB_FILE, JSON.stringify(meetings, null, 2), 'utf8');
}

/** Lista as reuniões (mais recentes primeiro), sem o transcript completo. */
export async function listMeetings() {
  const meetings = await readAll();
  return meetings
    .map(({ transcript, ...rest }) => ({
      ...rest,
      transcriptPreview: (transcript || '').slice(0, 200),
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Retorna uma reunião completa pelo id. */
export async function getMeeting(id) {
  const meetings = await readAll();
  return meetings.find((m) => m.id === id) || null;
}

/** Cria uma reunião. */
export async function createMeeting({ title, transcript, summary, durationMs }) {
  const meetings = await readAll();
  const meeting = {
    id: crypto.randomUUID(),
    title: title || `Reunião ${new Date().toLocaleString('pt-BR')}`,
    transcript: transcript || '',
    summary: summary || null,
    durationMs: durationMs || 0,
    createdAt: new Date().toISOString(),
  };
  meetings.push(meeting);
  await writeAll(meetings);
  return meeting;
}

/** Atualiza campos de uma reunião existente. */
export async function updateMeeting(id, patch) {
  const meetings = await readAll();
  const idx = meetings.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  meetings[idx] = { ...meetings[idx], ...patch, id };
  await writeAll(meetings);
  return meetings[idx];
}
