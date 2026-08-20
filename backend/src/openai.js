// Camada fina sobre o SDK da OpenAI: transcrição de áudio e geração de resumo.
import OpenAI from 'openai';
import nodeFetch from 'node-fetch';
import FormData from 'form-data';
import { splitAudio, remuxWebm, probeDurationMs, extractClipWav } from './audio-split.js';

// Modelo de transcrição: gpt-4o-transcribe-diarize — transcreve com diarização
// e devolve segmentos com tempo (start/end) via response_format=diarized_json.
// (Esse modelo NÃO aceita prompt, temperature, logprobs nem timestamp_granularities.)
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || 'pt';

let client = null;

/** Cria (ou reutiliza) o client da OpenAI. Lança erro se a chave não existir. */
export function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Veja backend/.env.example');
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 4, // o SDK já repete em erros de conexão/5xx
      timeout: 120000, // upload de áudio pode demorar
    });
  }
  return client;
}

// Repete uma operação em erros transitórios de rede (ex.: "Premature close",
// ECONNRESET) — comum em uploads de áudio a partir de hosts com banda limitada.
async function withRetry(fn, label = 'openai') {
  const transient =
    /premature close|econnreset|econnrefused|terminated|socket hang up|fetch failed|network|etimedout|epipe|aborted|enotfound/i;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const status = Number(err?.status);
      if (status >= 400 && status < 500) break; // erro de cliente: repetir não adianta
      const retryable = transient.test(msg) || err?.name === 'APIConnectionError' || status >= 500;
      if (!retryable || attempt === 4) break;
      const wait = 1500 * attempt;
      console.warn(`OpenAI ${label}: tentativa ${attempt} falhou (${msg.slice(0, 90)}). Repetindo em ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Converte a resposta `diarized_json` em segmentos {startMs,endMs,text,speaker}.
 * O diarized_json vem como { text, segments: [{speaker, text, start, end}] }
 * (start/end em segundos; speaker = "A"/"B"/… a menos que se passem referências).
 * Função pura — separada para poder ser testada sem chamar a API.
 * @param {{segments?: Array<{speaker?:string,text?:string,start?:number,end?:number}>}} result
 * @returns {Array<{startMs:number,endMs:number,text:string,speaker:string|null}>}
 */
// Colapsa repetições consecutivas idênticas do mesmo locutor (ex.: alucinação
// "E aí / E aí / E aí" em silêncio).
function collapseRepeats(segs) {
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === s.speaker && prev.text.toLowerCase() === s.text.toLowerCase()) {
      prev.endMs = s.endMs; // só estende o tempo do anterior
      continue;
    }
    out.push(s);
  }
  return out;
}

export function diarizedToSegments(result) {
  const segs = Array.isArray(result?.segments) ? result.segments : [];
  const cleaned = segs
    .filter((s) => (s.text || '').trim())
    .map((s) => ({
      startMs: Math.round((s.start || 0) * 1000),
      endMs: Math.round((s.end || 0) * 1000),
      text: (s.text || '').trim(),
      speaker: s.speaker || null,
    }));
  return collapseRepeats(cleaned);
}

// Converte a resposta verbose_json (whisper-1) em segmentos, descartando trechos
// sem fala / de baixa confiança (reduz alucinação em silêncio).
function verboseToSegments(result) {
  const segs = Array.isArray(result?.segments) ? result.segments : [];
  const cleaned = segs
    .filter(
      (s) =>
        (s.text || '').trim() &&
        (s.no_speech_prob == null || s.no_speech_prob < 0.6) &&
        (s.avg_logprob == null || s.avg_logprob > -1.0)
    )
    .map((s) => ({
      startMs: Math.round((s.start || 0) * 1000),
      endMs: Math.round((s.end || 0) * 1000),
      text: (s.text || '').trim(),
      speaker: null,
    }));
  return collapseRepeats(cleaned);
}

// POST multipart para /audio/transcriptions, com retry de rede. `buildForm` cria
// uma FormData NOVA a cada tentativa (streams de form não podem ser reusados).
// IMPORTANTE: usamos node-fetch + form-data (Node https), NÃO o fetch nativo do
// Node (undici), que no Render free derrubava o upload com "Premature close".
async function postTranscription(buildForm, label) {
  return withRetry(async () => {
    const form = buildForm();
    const res = await nodeFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }, label);
}

// Transcrição com diarização (gpt-4o-transcribe-diarize). Limite do modelo:
// ~1400s (≈23min) de áudio, mesmo com chunking_strategy=auto.
// `knownSpeakers` (opcional): [{name, wav}] — amostras de voz de referência; o
// modelo rotula os segmentos com esses nomes em vez de recomeçar em A/B.
async function transcribeDiarize(buffer, filename, mimetype, knownSpeakers = null) {
  const result = await postTranscription(() => {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimetype });
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', TRANSCRIBE_LANGUAGE);
    form.append('response_format', 'diarized_json'); // segmentos com tempo + locutor
    form.append('chunking_strategy', 'auto'); // obrigatório para áudios > 30s
    for (const sp of knownSpeakers || []) {
      form.append('known_speaker_names[]', sp.name);
      form.append('known_speaker_references[]', `data:audio/wav;base64,${sp.wav.toString('base64')}`);
    }
    return form;
  }, 'diarize');
  return diarizedToSegments(result);
}

// Escolhe, por locutor, um trecho bom para servir de amostra de voz: o segmento
// mais longo daquele locutor (mín. 2.5s, cortado a 8s). Devolve [{name, wav}]
// ou null se não der (aí os blocos seguintes diarizam sem referência).
async function buildSpeakerRefs(chunkBuffer, segments) {
  const bySpeaker = new Map();
  for (const s of segments) {
    if (!s.speaker) continue;
    const dur = s.endMs - s.startMs;
    const best = bySpeaker.get(s.speaker);
    if (!best || dur > best.dur) bySpeaker.set(s.speaker, { startMs: s.startMs, dur });
  }
  if (!bySpeaker.size) return null;
  try {
    const refs = [];
    for (const [name, seg] of bySpeaker) {
      if (seg.dur < 2500) continue; // curto demais para caracterizar a voz
      const durMs = Math.min(seg.dur, 8000);
      refs.push({ name, wav: await extractClipWav(chunkBuffer, seg.startMs, durMs) });
    }
    return refs.length ? refs : null;
  } catch (err) {
    console.warn(`Amostras de locutor indisponíveis (${String(err?.message || err).slice(0, 100)}) — seguindo sem referência.`);
    return null;
  }
}

// Fallback: whisper-1 com verbose_json (sem limite prático de duração, mas
// qualidade menor). Não diariza — devolve speaker null.
async function transcribeWhisper(buffer, filename, mimetype) {
  const result = await postTranscription(() => {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimetype });
    form.append('model', 'whisper-1');
    form.append('language', TRANSCRIBE_LANGUAGE);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    return form;
  }, 'whisper');
  return verboseToSegments(result);
}

/**
 * Áudio longo: divide em blocos de ~20min, diariza cada bloco e junta tudo
 * corrigindo os timestamps pelo offset de cada bloco. Para manter os locutores
 * CONSISTENTES entre os blocos, extrai amostras de voz do primeiro bloco e as
 * passa como referência nos seguintes (senão cada bloco recomeçaria em A/B).
 */
async function transcribeDiarizeChunked(buffer, mimetype, onProgress = null) {
  const { chunks, cleanup } = await splitAudio(buffer, 1200); // 20min < teto de ~1400s
  try {
    // Anuncia o total ANTES do primeiro bloco. Sem isso, quem acompanha fica
    // vários minutos sem número nenhum enquanto o bloco 1 é transcrito, e a
    // transcrição parece travada.
    if (onProgress) onProgress(0, chunks.length);
    const all = [];
    let refs = null;
    // Sequencial (não paralelo): dois uploads grandes ao mesmo tempo saturam a
    // banda do host e derrubam a conexão com a OpenAI ("Premature close").
    for (let i = 0; i < chunks.length; i++) {
      const { buffer: buf, startMs } = chunks[i];
      let segs;
      try {
        segs = await transcribeDiarize(buf, `chunk${i}.webm`, mimetype, refs);
      } catch (err) {
        // Se a API recusar as referências (parâmetro/formato), não perde o bloco:
        // repete sem referência e desliga a consistência daqui em diante.
        if (refs && Number(err?.status) === 400) {
          console.warn(`Referências de locutor recusadas no bloco ${i} — seguindo sem (rótulos podem variar): ${String(err?.message).slice(0, 140)}`);
          refs = null;
          segs = await transcribeDiarize(buf, `chunk${i}.webm`, mimetype);
        } else {
          throw err;
        }
      }
      if (i === 0 && chunks.length > 1) {
        refs = await buildSpeakerRefs(buf, segs);
      }
      for (const s of segs) {
        all.push({ ...s, startMs: s.startMs + startMs, endMs: s.endMs + startMs });
      }
      if (onProgress) onProgress(i + 1, chunks.length);
    }
    all.sort((a, b) => a.startMs - b.startMs);
    return collapseRepeats(all);
  } finally {
    await cleanup().catch(() => {});
  }
}

/**
 * Transcreve um ÁUDIO INTEIRO devolvendo trechos com tempo (e locutor quando o
 * modelo diariza). Tenta o gpt-4o-transcribe-diarize direto; se o áudio passar
 * do limite de duração do modelo (~23min), divide em blocos e diariza cada um.
 * Se o corte falhar (ex.: ffmpeg indisponível), cai para o whisper-1.
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} [mimetype]
 * @param {(current:number, total:number) => void} [onProgress] blocos concluídos (áudio longo)
 * @returns {Promise<{segments:Array<{startMs:number,endMs:number,text:string,speaker:string|null}>, durationMs:number|null}>}
 */
export async function transcribeVerbose(buffer, filename = 'audio.webm', mimetype = 'audio/webm', onProgress = null) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Veja backend/.env.example');
  }
  // Normaliza o container (escreve duração/cues). O webm do MediaRecorder vem
  // sem cabeçalho de duração, e o gpt-4o-transcribe-diarize rejeita isso como
  // "Audio file might be corrupted or unsupported". Se o remux falhar, usa o
  // original.
  let audio = buffer;
  let durationMs = null;
  try {
    audio = await remuxWebm(buffer);
    durationMs = await probeDurationMs(audio); // já tem cabeçalho -> instantâneo
  } catch (err) {
    console.warn(`Remux pré-transcrição falhou — usando original: ${String(err?.message || err).slice(0, 120)}`);
  }

  // Corte (com fallback p/ whisper-1 se o corte falhar).
  const chunkedThenWhisper = async () => {
    try {
      return await transcribeDiarizeChunked(audio, mimetype, onProgress);
    } catch (splitErr) {
      console.warn(
        `Corte/diarização em blocos falhou (${String(splitErr?.message || splitErr).slice(0, 140)}). ` +
        'Fallback p/ whisper-1.'
      );
      return await transcribeWhisper(audio, filename, mimetype);
    }
  };

  // Já sabemos que é longo (> ~23min): vai direto pro corte, sem mandar o arquivo
  // inteiro pra OpenAI só pra ser recusado por duração.
  let segments;
  if (durationMs != null && durationMs > 1380000) {
    segments = await chunkedThenWhisper();
  } else {
    try {
      segments = await transcribeDiarize(audio, filename, mimetype);
    } catch (err) {
      const msg = String(err?.message || '');
      // Rede de segurança: se mesmo assim vier "too long" (duração desconhecida).
      const tooLong = err?.status === 400 && /maximum|longer than|duration|1400/i.test(msg);
      if (!tooLong) throw err;
      segments = await chunkedThenWhisper();
    }
  }
  return { segments, durationMs };
}

/**
 * Gera um resumo estruturado a partir da transcrição completa.
 * @param {string} transcript
 * @param {string} [title]
 * @returns {Promise<{summary:string, action_items:string[], topics:string[]}>}
 */
export async function summarize(transcript, title = 'Reunião') {
  const openai = getClient();

  const system =
    'Você é um assistente que resume reuniões em português do Brasil. ' +
    'A partir da transcrição (que pode conter erros de fala), produza um resumo ' +
    'claro e objetivo, a lista de itens de ação (action items) e os principais ' +
    'tópicos discutidos. Responda SOMENTE com JSON válido.';

  const user =
    `Título da reunião: ${title}\n\n` +
    `Transcrição:\n"""\n${transcript}\n"""\n\n` +
    'Retorne um objeto JSON com as chaves: ' +
    '"summary" (string em markdown, parágrafos curtos), ' +
    '"action_items" (array de strings, cada uma uma tarefa acionável com responsável quando houver), ' +
    '"topics" (array de strings com os tópicos principais).';

  const completion = await openai.chat.completions.create({
    model: SUMMARY_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { summary: raw, action_items: [], topics: [] };
  }
  return {
    summary: parsed.summary || '',
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
  };
}

export const config = { TRANSCRIBE_MODEL, SUMMARY_MODEL, TRANSCRIBE_LANGUAGE };
