// Corte de áudio em blocos (para áudios longos que passam do limite de duração
// de alguns modelos de transcrição). Usa o binário estático do ffmpeg, então
// não precisa de ffmpeg instalado no sistema (funciona no Render nativo).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static não disponível'));
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg saiu ${code}: ${stderr.slice(-300)}`))
    );
  });
}

/**
 * Divide um áudio (Buffer) em blocos de até `segmentSeconds` segundos, SEM
 * recodificar (-c copy). Devolve os blocos com o offset (em ms) de onde cada um
 * começa no áudio original, mais um `cleanup()` para apagar os temporários.
 * @param {Buffer} buffer
 * @param {number} [segmentSeconds]
 * @returns {Promise<{chunks: Array<{buffer: Buffer, startMs: number}>, cleanup: () => Promise<void>}>}
 */
export async function splitAudio(buffer, segmentSeconds = 1200) {
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-split-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    const input = path.join(dir, 'input.webm');
    const listFile = path.join(dir, 'list.csv');
    await fs.writeFile(input, buffer);

    await runFfmpeg([
      '-i', input,
      '-f', 'segment',
      '-segment_time', String(segmentSeconds),
      '-c', 'copy',
      '-reset_timestamps', '1',
      '-segment_list', listFile,
      '-segment_list_type', 'csv',
      path.join(dir, 'chunk_%03d.webm'),
    ]);

    // CSV: "<basename>,<start>,<end>" (uma linha por bloco).
    const csv = await fs.readFile(listFile, 'utf8');
    const chunks = [];
    for (const line of csv.split('\n')) {
      const cols = line.trim().split(',');
      if (cols.length < 2) continue;
      const fname = path.basename(cols[0]);
      const startMs = Math.round(parseFloat(cols[1]) * 1000);
      const buf = await fs.readFile(path.join(dir, fname));
      chunks.push({ buffer: buf, startMs });
    }
    if (!chunks.length) throw new Error('nenhum bloco gerado pelo ffmpeg');
    return { chunks, cleanup };
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }
}

/**
 * "Remuxa" um webm (reescreve o container com -c copy, SEM recodificar) para
 * gravar a duração e o índice de busca (cues). O webm do MediaRecorder vem sem
 * esses metadados, o que deixa o player lento para carregar e dar seek.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>} novo webm com duração + cues
 */
export async function remuxWebm(buffer) {
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-remux-'));
  try {
    const input = path.join(dir, 'in.webm');
    const output = path.join(dir, 'out.webm');
    await fs.writeFile(input, buffer);
    await runFfmpeg(['-i', input, '-c', 'copy', output]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
