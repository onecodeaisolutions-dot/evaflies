// Armazenamento dos áudios das reuniões: Supabase Storage ou disco local.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { useSupabase, supabase, SUPABASE_BUCKET } from './storage-config.js';
import { remuxWebm } from './audio-split.js';

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
  // Reescreve o container gravando duração + índice de busca (player carrega e
  // dá seek na hora). Se o remux falhar, usa o arquivo original.
  let data = buffer;
  try {
    data = await remuxWebm(buffer);
  } catch (err) {
    console.warn(`Remux do áudio falhou — salvando original: ${String(err?.message || err).slice(0, 140)}`);
  }
  if (useSupabase) {
    const { error } = await supabase()
      .storage.from(SUPABASE_BUCKET)
      .upload(`${id}.webm`, data, { contentType, upsert: false });
    if (error) throw error;
  } else {
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    await fs.writeFile(path.join(AUDIO_DIR, `${id}.webm`), data);
  }
  return id;
}

/** Remove o áudio de uma reunião (ao excluí-la). */
export async function deleteAudio(id) {
  const sid = safeId(id);
  if (!sid) return;
  if (useSupabase) {
    await supabase().storage.from(SUPABASE_BUCKET).remove([`${sid}.webm`]);
  } else {
    await fs.rm(path.join(AUDIO_DIR, `${sid}.webm`), { force: true });
  }
}

/** Carrega o áudio inteiro como Buffer (para transcrever sob demanda). */
export async function loadAudio(id) {
  const sid = safeId(id);
  if (!sid) throw new Error('id inválido');
  if (useSupabase) {
    const { data, error } = await supabase().storage.from(SUPABASE_BUCKET).download(`${sid}.webm`);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFile(path.join(AUDIO_DIR, `${sid}.webm`));
}

/** Responde com o áudio (redirect para URL assinada no Supabase, ou arquivo local com Range).
 *  opts.download: nome do arquivo para forçar download (Content-Disposition). */
export async function serveAudio(res, id, opts = {}) {
  const sid = safeId(id);
  if (!sid) return res.status(400).json({ error: 'id inválido' });
  const dl = opts.download ? String(opts.download).replace(/[^\w.\- ]+/g, '').slice(0, 100) : null;

  if (useSupabase) {
    const { data, error } = await supabase()
      .storage.from(SUPABASE_BUCKET)
      .createSignedUrl(`${sid}.webm`, SIGNED_URL_TTL, dl ? { download: dl } : undefined);
    if (error || !data?.signedUrl) return res.status(404).json({ error: 'áudio não encontrado' });
    return res.redirect(data.signedUrl);
  }

  // Local: sendFile já dá suporte a Range requests (seek).
  if (dl) res.setHeader('Content-Disposition', `attachment; filename="${dl}"`);
  res.type('audio/webm');
  return res.sendFile(path.join(AUDIO_DIR, `${sid}.webm`), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'áudio não encontrado' });
  });
}
