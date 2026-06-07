// Offscreen document: captura o áudio da aba + microfone, mixa, e:
//   1) grava em blocos (~20s) -> transcrição com timestamps;
//   2) grava continuamente -> áudio completo salvo ao final.

let audioContext = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;

// Gravador por blocos (transcrição)
let chunkRecorder = null;
let chunkBlobs = [];
let chunkStartMs = 0;

// Gravador contínuo (áudio completo)
let fullRecorder = null;
let fullBlobs = [];
let fullDone = null; // Promise resolvida quando o áudio completo está pronto

let running = false;
let restartTimer = null;
let sessionStartMs = 0;
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
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // 2) Microfone (opcional).
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    micStream = null;
    status('Microfone indisponível — gravando só o áudio da aba.');
  }

  // 3) Mixa aba + microfone num único stream.
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination); // você continua ouvindo a reunião
  if (micStream) audioContext.createMediaStreamSource(micStream).connect(destination);

  mixedStream = destination.stream;
  sessionStartMs = Date.now();
  running = true;

  startFullRecorder();
  startChunkRecorder();
  if (micStream) status('Gravando (aba + microfone)…');
}

const pickMime = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

// Gravador contínuo: acumula tudo num único arquivo válido.
function startFullRecorder() {
  fullBlobs = [];
  fullRecorder = new MediaRecorder(mixedStream, { mimeType: pickMime() });
  fullDone = new Promise((resolve) => {
    fullRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) fullBlobs.push(e.data);
    };
    fullRecorder.onstop = () => resolve(new Blob(fullBlobs, { type: 'audio/webm' }));
  });
  fullRecorder.start(2000); // emite pedaços a cada 2s (mesma sessão = arquivo válido)
}

// Gravador por blocos: reinicia a cada chunkMs para gerar arquivos transcrevíveis.
function startChunkRecorder() {
  chunkBlobs = [];
  chunkStartMs = Date.now() - sessionStartMs; // offset do início deste bloco
  chunkRecorder = new MediaRecorder(mixedStream, { mimeType: pickMime() });

  chunkRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunkBlobs.push(e.data);
  };

  chunkRecorder.onstop = async () => {
    const endMs = Date.now() - sessionStartMs;
    const blob = new Blob(chunkBlobs, { type: 'audio/webm' });
    if (blob.size > 1200) {
      await transcribeChunk(blob, chunkStartMs, endMs);
    }
    if (running) {
      startChunkRecorder(); // próximo bloco
    } else {
      await finishSession();
    }
  };

  chunkRecorder.start();
  restartTimer = setTimeout(() => {
    if (chunkRecorder && chunkRecorder.state !== 'inactive') chunkRecorder.stop();
  }, chunkMs);
}

async function transcribeChunk(blob, startMs, endMs) {
  try {
    const form = new FormData();
    form.append('audio', blob, `chunk-${Date.now()}.webm`);
    const res = await fetch(`${backendUrl}/api/transcribe`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`transcribe ${res.status}`);
    const { text } = await res.json();
    if (text && text.trim()) {
      send({ type: 'TRANSCRIPT_SEGMENT', text: text.trim(), startMs, endMs });
    }
  } catch (err) {
    status(`Falha ao transcrever um bloco (${err.message}). Continuando…`);
  }
}

// --------------------------------------------------------------------------
// Fim da gravação: sobe o áudio completo e avisa o background.
// --------------------------------------------------------------------------
function stopCapture() {
  running = false;
  if (restartTimer) clearTimeout(restartTimer);
  if (fullRecorder && fullRecorder.state !== 'inactive') fullRecorder.stop();
  if (chunkRecorder && chunkRecorder.state !== 'inactive') {
    chunkRecorder.stop(); // dispara onstop -> último bloco -> finishSession()
  } else {
    finishSession();
  }
}

async function finishSession() {
  let audioId = null;
  try {
    status('Salvando áudio…');
    const blob = await fullDone; // espera o gravador contínuo finalizar
    if (blob && blob.size > 1200) {
      const form = new FormData();
      form.append('audio', blob, `meeting-${Date.now()}.webm`);
      const res = await fetch(`${backendUrl}/api/audio`, { method: 'POST', body: form });
      if (res.ok) ({ audioId } = await res.json());
    }
  } catch (err) {
    status(`Falha ao salvar o áudio (${err.message}).`);
  }
  cleanup();
  send({ type: 'CAPTURE_STOPPED', audioId });
}

function cleanup() {
  [tabStream, micStream, mixedStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = mixedStream = tabStream = micStream = null;
  chunkRecorder = fullRecorder = null;
  chunkBlobs = [];
  fullBlobs = [];
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
