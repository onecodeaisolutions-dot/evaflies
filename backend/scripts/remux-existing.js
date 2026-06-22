// Migração única: remuxa os áudios JÁ existentes (grava duração + índice de
// busca) para que carreguem/dêem seek na hora, igual aos novos.
//
// Como rodar:
//   - No Render: Shell -> `node scripts/remux-existing.js`
//   - Local:     `npm run remux:existing` (no diretório backend/)
//
// É idempotente (seguro rodar mais de uma vez). Pula arquivos que falham
// (ex.: não-webm) e segue em frente.
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useSupabase, supabase, SUPABASE_BUCKET } from '../src/storage-config.js';
import { remuxWebm } from '../src/audio-split.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'audio')
  : path.join(__dirname, '..', 'data', 'audio');

async function remuxOne(name, getBuf, putBuf) {
  try {
    const buf = await getBuf();
    const out = await remuxWebm(buf);
    await putBuf(out);
    console.log(`  ✓ ${name} (${buf.length} → ${out.length} bytes)`);
    return true;
  } catch (err) {
    console.warn(`  ✗ ${name}: ${String(err?.message || err).slice(0, 160)}`);
    return false;
  }
}

async function runLocal() {
  let files = [];
  try {
    files = (await fs.readdir(AUDIO_DIR)).filter((f) => f.endsWith('.webm'));
  } catch {
    /* diretório ainda não existe */
  }
  console.log(`Modo arquivo local — ${files.length} áudio(s) em ${AUDIO_DIR}`);
  let ok = 0;
  for (const f of files) {
    const p = path.join(AUDIO_DIR, f);
    if (await remuxOne(f, () => fs.readFile(p), (out) => fs.writeFile(p, out))) ok++;
  }
  return { ok, total: files.length };
}

async function runSupabase() {
  const bucket = supabase().storage.from(SUPABASE_BUCKET);
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await bucket.list('', { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data.filter((o) => o.name.endsWith('.webm')));
    if (data.length < 100) break;
    offset += data.length;
  }
  console.log(`Supabase Storage — ${all.length} áudio(s) no bucket "${SUPABASE_BUCKET}"`);
  let ok = 0;
  for (const obj of all) {
    const success = await remuxOne(
      obj.name,
      async () => {
        const { data, error } = await bucket.download(obj.name);
        if (error) throw error;
        return Buffer.from(await data.arrayBuffer());
      },
      async (out) => {
        const { error } = await bucket.upload(obj.name, out, { contentType: 'audio/webm', upsert: true });
        if (error) throw error;
      }
    );
    if (success) ok++;
  }
  return { ok, total: all.length };
}

(async () => {
  console.log(`Storage: ${useSupabase ? 'supabase' : 'file'}`);
  const { ok, total } = useSupabase ? await runSupabase() : await runLocal();
  console.log(`\nConcluído: ${ok}/${total} remuxado(s) com sucesso.`);
})().catch((err) => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
