// Camada fina sobre o SDK da OpenAI: transcrição de áudio e geração de resumo.
import OpenAI from 'openai';
import nodeFetch from 'node-fetch';
import FormData from 'form-data';

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

  // Colapsa repetições consecutivas idênticas do mesmo locutor.
  const out = [];
  for (const s of cleaned) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === s.speaker && prev.text.toLowerCase() === s.text.toLowerCase()) {
      prev.endMs = s.endMs; // só estende o tempo do anterior
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Transcreve um ÁUDIO INTEIRO devolvendo trechos com tempo e locutor. Usa
 * gpt-4o-transcribe-diarize (response_format=diarized_json).
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} [mimetype]
 * @returns {Promise<Array<{startMs:number,endMs:number,text:string,speaker:string|null}>>}
 */
export async function transcribeVerbose(buffer, filename = 'audio.webm', mimetype = 'audio/webm') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Veja backend/.env.example');
  }
  // IMPORTANTE: chamamos a OpenAI direto via node-fetch + form-data (Node https),
  // NÃO pelo fetch nativo do Node (undici), que no Render free derrubava o upload
  // com "Premature close". O form-data manda o áudio com Content-Length correto.
  const result = await withRetry(async () => {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimetype });
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', TRANSCRIBE_LANGUAGE);
    form.append('response_format', 'diarized_json'); // segmentos com tempo + locutor
    form.append('chunking_strategy', 'auto'); // obrigatório para áudios > 30s

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
      const err = new Error(`OpenAI ${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }, 'transcribeVerbose');

  return diarizedToSegments(result);
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
