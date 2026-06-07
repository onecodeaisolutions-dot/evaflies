// Camada fina sobre o SDK da OpenAI: transcrição de áudio e geração de resumo.
import OpenAI, { toFile } from 'openai';

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE || 'pt';

let client = null;

/** Cria (ou reutiliza) o client da OpenAI. Lança erro se a chave não existir. */
export function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Veja backend/.env.example');
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
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
  };
  // whisper-1 aceita response_format; os modelos gpt-4o-transcribe retornam json por padrão.
  if (TRANSCRIBE_MODEL === 'whisper-1') {
    params.response_format = 'json';
  }

  const result = await openai.audio.transcriptions.create(params);
  return (result.text || '').trim();
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
