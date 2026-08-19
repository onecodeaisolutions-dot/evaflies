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

// Roda o ffmpeg só para capturar o stderr (onde ele imprime infos do arquivo),
// ignorando o código de saída. Usado para ler a duração.
function runFfmpegCapture(args) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve('');
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(stderr));
    proc.on('close', () => resolve(stderr));
  });
}

/**
 * Lê a duração de um áudio (ms). Funciona melhor em arquivos já remuxados (com
 * cabeçalho de duração) — aí é instantâneo. Devolve null se não conseguir.
 * @param {Buffer} buffer
 * @returns {Promise<number|null>}
 */
export async function probeDurationMs(buffer) {
  if (!ffmpegPath) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-probe-'));
  try {
    const input = path.join(dir, 'in.webm');
    await fs.writeFile(input, buffer);
    const info = await runFfmpegCapture(['-i', input]);
    const m = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

/**
 * Recodifica QUALQUER áudio (mp3, m4a, wav, ogg, mp4…) para webm/opus mono —
 * o formato que o resto do sistema assume. Necessário porque o remux por cópia
 * (-c copy) só funciona quando o áudio já é opus/vorbis: um mp3 ou m4a não cabe
 * num container webm sem recodificar, e seguiria salvo com bytes que não batem
 * com o nome ".webm" (a transcrição então falha).
 * Recodificar também encolhe bastante o arquivo — um WAV de 1h (~600MB) vira
 * ~20MB — o que mantém áudios enviados à mão dentro do limite de upload.
 * @param {Buffer} buffer áudio em qualquer formato (o ffmpeg detecta sozinho)
 * @returns {Promise<Buffer>} webm/opus 48kbps mono
 */
export async function transcodeToWebm(buffer) {
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-transcode-'));
  try {
    const input = path.join(dir, 'in'); // sem extensão: o ffmpeg detecta pelo conteúdo
    const output = path.join(dir, 'out.webm');
    await fs.writeFile(input, buffer);
    await runFfmpeg([
      '-i', input,
      '-vn',            // descarta vídeo (ex.: .mp4 de reunião gravada)
      '-c:a', 'libopus',
      '-b:a', '48k',    // mesmo bitrate da gravação pela extensão
      '-ac', '1',       // mono: voz não ganha nada com estéreo
      output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Recorta um trecho do áudio e devolve como WAV 16kHz mono (formato pequeno e
 * universal — usado como amostra de voz de referência na diarização).
 * @param {Buffer} buffer áudio de origem (webm)
 * @param {number} startMs início do trecho
 * @param {number} durMs duração do trecho
 * @returns {Promise<Buffer>} wav pcm16 16kHz mono
 */
export async function extractClipWav(buffer, startMs, durMs) {
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-clip-'));
  try {
    const input = path.join(dir, 'in.webm');
    const output = path.join(dir, 'out.wav');
    await fs.writeFile(input, buffer);
    await runFfmpeg([
      '-ss', (startMs / 1000).toFixed(3),
      '-t', (durMs / 1000).toFixed(3),
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
