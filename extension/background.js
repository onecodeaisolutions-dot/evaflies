// Service worker (MV3): orquestra a captura de áudio e a transcrição.
//
// Fluxo:
//   popup --START--> background --getMediaStreamId--> cria offscreen --START_CAPTURE-->
//   offscreen grava/mixa, envia blocos ao backend e devolve os textos -->
//   background acumula em chrome.storage e repassa para o popup.
//   No STOP, background salva a reunião no backend (com resumo).
import { getSettings } from './config.js';

const SESSION_KEY = 'evaflies_session';
const OFFSCREEN_URL = 'offscreen.html';

// --------------------------------------------------------------------------
// Estado da sessão (persistido em chrome.storage para sobreviver a restarts).
// --------------------------------------------------------------------------
async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

async function setSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function patchSession(patch) {
  const current = (await getSession()) || {};
  const next = { ...current, ...patch };
  await setSession(next);
  return next;
}

function broadcast(message) {
  // Envia para o popup (se aberto). Ignora erro quando ninguém escuta.
  chrome.runtime.sendMessage({ target: 'popup', ...message }).catch(() => {});
}

// --------------------------------------------------------------------------
// Offscreen document (onde o áudio é realmente gravado em MV3).
// --------------------------------------------------------------------------
async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Gravar e mixar o áudio da aba e do microfone para transcrição.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument();
  }
}

// --------------------------------------------------------------------------
// Início / fim da gravação
// --------------------------------------------------------------------------
async function startRecording() {
  const settings = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Nenhuma aba ativa encontrada.');

  // Gera um streamId da aba que será consumido dentro do offscreen document.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await setSession({
    recording: true,
    startedAt: Date.now(),
    tabTitle: tab.title || 'Reunião',
    transcript: '',
    segments: [],
    status: 'Gravando…',
    audioId: null,
    meeting: null,
  });

  await ensureOffscreen();

  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    backendUrl: settings.backendUrl,
    chunkMs: settings.chunkMs,
    userName: settings.userName,
    othersName: settings.othersName,
  }).catch(() => {});

  broadcast({ type: 'SESSION_UPDATE' });
}

async function stopRecording() {
  await patchSession({ status: 'Finalizando…' });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' }).catch(() => {});
  broadcast({ type: 'SESSION_UPDATE' });
}

// Chamado quando o offscreen confirma que parou: salva a reunião no backend.
async function finalize() {
  const session = await getSession();
  await closeOffscreen();

  if (!session) return;

  const transcript = (session.transcript || '').trim();
  const durationMs = session.startedAt ? Date.now() - session.startedAt : 0;

  if (!transcript) {
    await patchSession({ recording: false, status: 'Sem áudio transcrito.' });
    broadcast({ type: 'SESSION_UPDATE' });
    return;
  }

  await patchSession({ recording: false, status: 'Gerando resumo…' });
  broadcast({ type: 'SESSION_UPDATE' });

  try {
    const settings = await getSettings();
    const res = await fetch(`${settings.backendUrl}/api/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: session.tabTitle,
        transcript,
        segments: session.segments || [],
        durationMs,
        audioId: session.audioId || null,
        summarize: true,
      }),
    });
    if (!res.ok) throw new Error(`Backend respondeu ${res.status}`);
    const meeting = await res.json();
    await patchSession({ status: 'Concluído ✅', meeting });
  } catch (err) {
    await patchSession({ status: `Salvo localmente (erro no backend: ${err.message})` });
  }
  broadcast({ type: 'SESSION_UPDATE' });
}

// --------------------------------------------------------------------------
// Mensagens
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { target, type } = message || {};
  if (target && target !== 'background') return; // não é pra mim

  (async () => {
    switch (type) {
      case 'START':
        await startRecording();
        sendResponse({ ok: true });
        break;

      case 'STOP':
        await stopRecording();
        sendResponse({ ok: true });
        break;

      case 'GET_SESSION':
        sendResponse({ session: await getSession() });
        break;

      // Vindos do offscreen:
      case 'TRANSCRIPT_SEGMENT': {
        const session = (await getSession()) || {};
        const segments = Array.isArray(session.segments) ? session.segments : [];
        segments.push({
          startMs: message.startMs,
          endMs: message.endMs,
          text: message.text,
          speaker: message.speaker || null,
        });
        // Ordena por tempo de início (os canais chegam intercalados).
        segments.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
        const transcript = segments
          .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
          .join('\n');
        await patchSession({ transcript, segments });
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;
      }

      case 'CAPTURE_STATUS':
        await patchSession({ status: message.status });
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;

      case 'CAPTURE_ERROR':
        await patchSession({ recording: false, status: `Erro: ${message.error}` });
        await closeOffscreen();
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;

      case 'CAPTURE_STOPPED':
        await patchSession({ audioId: message.audioId || null });
        await finalize();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Mensagem desconhecida.' });
    }
  })().catch((err) => {
    console.error('background error:', err);
    patchSession({ recording: false, status: `Erro: ${err.message}` }).then(() =>
      broadcast({ type: 'SESSION_UPDATE' })
    );
    sendResponse({ ok: false, error: err.message });
  });

  return true; // resposta assíncrona
});
