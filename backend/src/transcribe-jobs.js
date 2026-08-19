// Jobs de transcrição, em memória. Ficam aqui (e não no server.js) para que a
// API REST e o MCP compartilhem o MESMO mapa: transcrição disparada pelo Claude
// aparece no painel e vice-versa.
// Se o servidor reiniciar no meio, o job some e a reunião volta a oferecer o
// botão Transcrever — é só pedir de novo.
import { loadAudio } from './audio-store.js';
import { transcribeVerbose, summarize } from './openai.js';
import { updateMeeting } from './store.js';

const jobs = new Map(); // meetingId -> {state, current, total, error}

/** Estado do job de uma reunião (null se nunca rodou / já terminou). */
export function getJob(meetingId) {
  return jobs.get(meetingId) || null;
}

async function runTranscription(meeting) {
  const job = { state: 'running', current: 0, total: 0, error: null };
  jobs.set(meeting.id, job);
  try {
    const buffer = await loadAudio(meeting.audioId);
    const { segments, durationMs: measuredMs } = await transcribeVerbose(
      buffer, 'audio.webm', 'audio/webm',
      (current, total) => { job.current = current; job.total = total; }
    );

    const transcript = segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n');
    let summary = null;
    if (transcript.trim()) {
      try {
        summary = await summarize(transcript, meeting.title);
      } catch (err) {
        console.error('Falha ao resumir:', err.message);
      }
    }

    // Conserta a duração se ela tiver vindo zerada (ex.: áudio reenviado manualmente).
    const patch = { transcript, segments, summary };
    if (!meeting.durationMs && measuredMs) patch.durationMs = measuredMs;
    await updateMeeting(meeting.id, patch);
    jobs.delete(meeting.id); // done: quem consultar passa a ver a reunião pronta
  } catch (err) {
    console.error(`Transcrição da reunião ${meeting.id} falhou:`, err);
    job.state = 'error';
    job.error = `Falha na transcrição: ${err.message}`;
  }
}

/** Dispara a transcrição em segundo plano. Se já houver uma rodando, devolve a
 *  existente em vez de começar outra. */
export function startTranscription(meeting) {
  const existing = jobs.get(meeting.id);
  if (existing && existing.state === 'running') return existing;
  runTranscription(meeting); // sem await: roda em segundo plano
  return { state: 'running', current: 0, total: 0 };
}
