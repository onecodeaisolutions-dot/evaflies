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

// O offscreen é mantido aberto entre reuniões: ele segura os uploads em segundo
// plano (que sobreviveriam à morte do service worker) e deixa a próxima gravação
// começar na hora. Fechá-lo mataria um upload em andamento.

// --------------------------------------------------------------------------
// Início / fim da gravação
// --------------------------------------------------------------------------
// Badge no ícone: 'rec' enquanto grava, 'proc' enquanto transcreve, null limpa.
function setRecBadge(state) {
  try {
    if (state === 'rec') {
      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeBackgroundColor({ color: '#d33636' });
      chrome.action.setTitle({ title: 'EvaFlies — gravando reunião' });
    } else if (state === 'proc') {
      chrome.action.setBadgeText({ text: '···' });
      chrome.action.setBadgeBackgroundColor({ color: '#d18b1f' });
      chrome.action.setTitle({ title: 'EvaFlies — processando…' });
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'EvaFlies' });
    }
  } catch { /* action API indisponível */ }
}

async function startRecording() {
  const existing = await getSession();
  // Só bloqueia se já estiver gravando ou no curto "finalizando" (coletando o
  // áudio). Uploads/transcrições em segundo plano NÃO impedem uma nova gravação.
  if (existing && (existing.recording || existing.stopping)) {
    throw new Error('Aguarde a gravação atual finalizar para iniciar outra.');
  }
  const pendingUploads = existing?.pendingUploads || 0;
  const settings = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Nenhuma aba ativa encontrada.');

  // Gera um streamId da aba que será consumido dentro do offscreen document.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await setSession({
    recording: true,
    stopping: false,
    processing: false,
    pendingUploads, // preserva uploads em segundo plano de reuniões anteriores
    startedAt: Date.now(),
    endedAt: null,
    tabId: tab.id,
    tabTitle: tab.title || 'Reunião',
    transcript: '',
    segments: [],
    status: 'Gravando…',
    audioId: null,
    meeting: null,
  });

  await ensureOffscreen();
  setRecBadge('rec');

  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    backendUrl: settings.backendUrl,
    userName: settings.userName,
    othersName: settings.othersName,
    accessKey: settings.accessKey,
    tabTitle: tab.title || 'Reunião',
    autoStopSilenceMin: settings.autoStopSilenceMin,
  }).catch(() => {});

  broadcast({ type: 'SESSION_UPDATE' });
}

// Badge do ícone conforme o estado: gravando > processando em 2º plano > limpo.
function badgeFor(session) {
  if (session?.recording) return 'rec';
  if ((session?.pendingUploads || 0) > 0) return 'proc';
  return null;
}

async function stopRecording() {
  setRecBadge('proc');
  // Curto "finalizando": para os gravadores e coleta o áudio. Bem rápido — só
  // até o offscreen mandar CAPTURE_STOPPED (aí já dá pra gravar a próxima).
  await patchSession({ recording: false, stopping: true, processing: true, endedAt: Date.now(), status: 'Finalizando…' });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_CAPTURE' }).catch(() => {});
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

      // Offscreen parou sozinho (silêncio): entra no curto "finalizando".
      case 'CAPTURE_STOPPING':
        setRecBadge('proc');
        await patchSession({ recording: false, stopping: true, processing: true, endedAt: Date.now() });
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;

      case 'CAPTURE_ERROR': {
        const next = await patchSession({ recording: false, stopping: false, processing: false, status: `Erro: ${message.error}` });
        setRecBadge(badgeFor(next));
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;
      }

      // Áudio coletado: dispositivo LIVRE. O upload/transcrição segue em 2º plano.
      case 'CAPTURE_STOPPED': {
        const s = (await getSession()) || {};
        const pending = (s.pendingUploads || 0) + 1;
        const next = await patchSession({
          recording: false,
          stopping: false,
          processing: false,
          pendingUploads: pending,
          status: 'Processando reunião em segundo plano…',
        });
        setRecBadge(badgeFor(next));
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;
      }

      // Upload em 2º plano terminou. Só mostra o resultado se não estiver gravando
      // outra agora (para não sobrescrever a sessão ativa).
      case 'FINALIZE_DONE': {
        const s = (await getSession()) || {};
        const pending = Math.max(0, (s.pendingUploads || 0) - 1);
        const patch = { pendingUploads: pending };
        if (!s.recording && !s.stopping) {
          if (message.meeting) {
            patch.meeting = message.meeting;
            patch.transcript = message.meeting.transcript || '';
            patch.segments = message.meeting.segments || [];
            patch.status = pending > 0 ? 'Processando reunião em segundo plano…' : 'Concluído ✅';
          } else {
            patch.status = message.error ? `Erro: ${message.error}` : 'Sem transcrição.';
          }
        }
        const next = await patchSession(patch);
        setRecBadge(badgeFor(next));
        broadcast({ type: 'SESSION_UPDATE' });
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Mensagem desconhecida.' });
    }
  })().catch((err) => {
    console.error('background error:', err);
    patchSession({ recording: false, stopping: false, status: `Erro: ${err.message}` }).then((next) => {
      setRecBadge(badgeFor(next));
      broadcast({ type: 'SESSION_UPDATE' });
    });
    sendResponse({ ok: false, error: err.message });
  });

  return true; // resposta assíncrona
});

// Para a gravação automaticamente se a aba que está sendo gravada for fechada.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session && session.recording && session.tabId === tabId) {
    await stopRecording();
  }
});
