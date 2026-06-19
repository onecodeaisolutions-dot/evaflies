// Camada fina sobre o SDK da OpenAI: transcrição de áudio e geração de resumo.
import OpenAI, { toFile } from 'openai';

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || 'pt';
// Prompt de contexto: ajuda o modelo a manter o idioma (pt-BR) e o vocabulário
// do domínio, reduzindo "deriva" para inglês e melhorando termos de vendas.
const TRANSCRIBE_PROMPT =
  process.env.TRANSCRIBE_PROMPT ||
  'Transcrição em português do Brasil de uma reunião de vendas entre um vendedor e um cliente.';

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
      const retryable =
        transient.test(msg) || err?.name === 'APIConnectionError' || Number(err?.status) >= 500;
      if (!retryable || attempt === 4) break;
      const wait = 1500 * attempt;
      console.warn(`OpenAI ${label}: tentativa ${attempt} falhou (${msg.slice(0, 90)}). Repetindo em ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Transcreve um bloco de áudio.
 * @param {Buffer} buffer  conteúdo do arquivo de áudio
 * @param {string} filename  nome com extensão (ex: "chunk.webm")
 * @param {string} [mimetype]
 * @returns {Promise<string>} texto transcrito
 */
export async function transcribe(buffer, filename = 'audio.webm', mimetype = 'audio/webm') {
  const openai = getClient();
  const file = await toFile(buffer, filename, { type: mimetype });

  const params = {
    file,
    model: TRANSCRIBE_MODEL,
    language: TRANSCRIBE_LANGUAGE,
    prompt: TRANSCRIBE_PROMPT,
  };
  // whisper-1 aceita response_format e temperatura (0 = menos alucinação).
  if (TRANSCRIBE_MODEL === 'whisper-1') {
    params.response_format = 'json';
    params.temperature = 0;
  }

  const result = await openai.audio.transcriptions.create(params);
  return (result.text || '').trim();
}

/**
 * Transcreve um ÁUDIO INTEIRO devolvendo trechos com tempo (para intercalar
 * canais). Usa whisper-1 (verbose_json) que retorna timestamps por segmento.
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} [mimetype]
 * @returns {Promise<Array<{startMs:number,endMs:number,text:string}>>}
 */
export async function transcribeVerbose(buffer, filename = 'audio.webm', mimetype = 'audio/webm') {
  const openai = getClient();
  // Recria o arquivo a cada tentativa para o retry poder reenviar o corpo.
  const result = await withRetry(async () => {
    const file = await toFile(buffer, filename, { type: mimetype });
    return openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: TRANSCRIBE_LANGUAGE,
      prompt: TRANSCRIBE_PROMPT,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      temperature: 0,
    });
  }, 'transcribeVerbose');
  const segs = Array.isArray(result.segments) ? result.segments : [];
  return segs
    // descarta trechos sem fala (reduz alucinação em silêncio).
    .filter((s) => (s.text || '').trim() && (s.no_speech_prob == null || s.no_speech_prob < 0.6))
    .map((s) => ({
      startMs: Math.round((s.start || 0) * 1000),
      endMs: Math.round((s.end || 0) * 1000),
      text: (s.text || '').trim(),
    }));
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
