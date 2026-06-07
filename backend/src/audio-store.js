// Armazenamento dos áudios das reuniões: Supabase Storage ou disco local.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { useSupabase, supabase, SUPABASE_BUCKET } from './storage-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const SIGNED_URL_TTL = 6 * 60 * 60; // 6h

const safeId = (id) => String(id).replace(/[^a-f0-9-]/gi, '');

export async function initAudioStore() {
  if (useSupabase) {
    try {
      await supabase().storage.createBucket(SUPABASE_BUCKET, { public: false });
    } catch {
      /* bucket provavelmente já existe — ok */
    }
  } else {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
  }
}

/** Salva um áudio e devolve o audioId (uuid). */
export async function saveAudio(buffer, contentType = 'audio/webm') {
  const id = crypto.randomUUID();
  if (useSupabase) {
    const { error } = await supabase()
      .storage.from(SUPABASE_BUCKET)
      .upload(`${id}.webm`, buffer, { contentType, upsert: false });
    if (error) throw error;
  } else {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    await fs.writeFile(path.join(AUDIO_DIR, `${id}.webm`), buffer);
  }
  return id;
}

/** Responde com o áudio (redirect para URL assinada no Supabase, ou arquivo local com Range). */
export async function serveAudio(res, id) {
  const sid = safeId(id);
  if (!sid) return res.status(400).json({ error: 'id inválido' });

  if (useSupabase) {
    const { data, error } = await supabase()
      .storage.from(SUPABASE_BUCKET)
      .createSignedUrl(`${sid}.webm`, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return res.status(404).json({ error: 'áudio não encontrado' });
    return res.redirect(data.signedUrl);
  }

  // Local: sendFile já dá suporte a Range requests (seek).
  res.type('audio/webm');
  return res.sendFile(path.join(AUDIO_DIR, `${sid}.webm`), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'áudio não encontrado' });
  });
}
