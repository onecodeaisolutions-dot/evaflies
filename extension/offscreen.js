// Offscreen document: captura o áudio da aba + microfone, mixa, grava em blocos
// e envia cada bloco ao backend para transcrição.

let audioContext = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;
let recorder = null;
let chunks = [];
let running = false;
let restartTimer = null;
let backendUrl = '';
let chunkMs = 20000;

function send(message) {
  chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
}

function status(text) {
  send({ type: 'CAPTURE_STATUS', status: text });
}

// --------------------------------------------------------------------------
// Captura e mixagem
// --------------------------------------------------------------------------
async function startCapture(streamId, _backendUrl, _chunkMs) {
  backendUrl = _backendUrl;
  chunkMs = _chunkMs || 20000;

  // 1) Áudio da aba (via streamId gerado pelo service worker).
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // 2) Microfone (opcional — pode falhar se a permissão não foi concedida).
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    micStream = null;
    status('Microfone indisponível — gravando só o áudio da aba.');
  }

  // 3) Mixa aba + microfone num único stream com a Web Audio API.
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  // Reproduz o áudio da aba de volta para você continuar ouvindo a reunião.
  tabSource.connect(audioContext.destination);

  if (micStream) {
    audioContext.createMediaStreamSource(micStream).connect(destination);
  }

  mixedStream = destination.stream;
  running = true;
  startChunkRecorder();
  if (micStream) status('Gravando (aba + microfone)…');
}

// Grava um bloco; ao parar, envia para transcrição e reinicia para o próximo.
function startChunkRecorder() {
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  recorder = new MediaRecorder(mixedStream, { mimeType: mime });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size > 1200) {
      await transcribeChunk(blob);
    }
    if (running) {
      startChunkRecorder(); // próximo bloco
    } else {
      cleanup();
      send({ type: 'CAPTURE_STOPPED' });
    }
  };

  recorder.start();
  restartTimer = setTimeout(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, chunkMs);
}

async function transcribeChunk(blob) {
  try {
    const form = new FormData();
    form.append('audio', blob, `chunk-${Date.now()}.webm`);
    const res = await fetch(`${backendUrl}/api/transcribe`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`transcribe ${res.status}: ${body.slice(0, 120)}`);
    }
    const { text } = await res.json();
    if (text && text.trim()) {
      send({ type: 'TRANSCRIPT_SEGMENT', text: text.trim() });
    }
  } catch (err) {
    status(`Falha ao transcrever um bloco (${err.message}). Continuando…`);
  }
}

function stopCapture() {
  running = false;
  if (restartTimer) clearTimeout(restartTimer);
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop(); // dispara onstop -> envia último bloco -> CAPTURE_STOPPED
  } else {
    cleanup();
    send({ type: 'CAPTURE_STOPPED' });
  }
}

function cleanup() {
  [tabStream, micStream, mixedStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = mixedStream = tabStream = micStream = recorder = null;
  chunks = [];
}

// --------------------------------------------------------------------------
// Mensagens vindas do service worker
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'START_CAPTURE') {
    startCapture(message.streamId, message.backendUrl, message.chunkMs)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        cleanup();
        send({ type: 'CAPTURE_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }
});
