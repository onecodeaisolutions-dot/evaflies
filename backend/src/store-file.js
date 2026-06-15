// Armazenamento das reuniões em arquivo JSON (modo local / fallback).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR pode apontar para um disco persistente (ex: no Render).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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

export async function initStore() {
  await ensureFile();
}

/** Toque leve no storage (keep-alive). */
export async function ping() {
  await ensureFile();
  return true;
}

/** Lista as reuniões (mais recentes primeiro), sem o transcript completo.
 *  ownerId: se informado, retorna só as reuniões desse dono. */
export async function listMeetings(ownerId) {
  const meetings = await readAll();
  return meetings
    .filter((m) => !ownerId || m.owner === ownerId)
    .map(({ transcript, segments, ...rest }) => ({
      ...rest,
      hasAudio: Boolean(rest.audioId),
      transcriptPreview: (transcript || '').slice(0, 200),
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Retorna uma reunião completa pelo id (respeitando o dono, se informado). */
export async function getMeeting(id, ownerId) {
  const meetings = await readAll();
  const m = meetings.find((x) => x.id === id) || null;
  if (m && ownerId && m.owner !== ownerId) return null;
  return m;
}

/** Cria uma reunião. */
export async function createMeeting({ title, transcript, segments, summary, durationMs, audioId, owner }) {
  const meetings = await readAll();
  const meeting = {
    id: crypto.randomUUID(),
    title: title || `Reunião ${new Date().toLocaleString('pt-BR')}`,
    transcript: transcript || '',
    segments: Array.isArray(segments) ? segments : [],
    summary: summary || null,
    durationMs: durationMs || 0,
    audioId: audioId || null,
    owner: owner || null,
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
