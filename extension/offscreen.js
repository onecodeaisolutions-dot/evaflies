// Offscreen document: captura o áudio da aba + microfone e:
//   1) grava CADA CANAL em blocos (~20s) -> transcrição com falante + timestamps
//      (microfone = "Você"; aba = "Participantes");
//   2) grava o mix continuamente -> áudio completo salvo ao final.

const SILENCE_THRESHOLD = 6; // amplitude (0..127). Abaixo disso = silêncio, não transcreve.

let audioContext = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;

// Canais de transcrição (1 = aba, +1 se houver microfone).
let channels = [];

// Gravador contínuo (áudio completo do mix)
let fullRecorder = null;
let fullBlobs = [];
let fullDone = null;

let running = false;
let meterTimer = null;
let sessionStartMs = 0;
let backendUrl = '';
let chunkMs = 20000;
let accessKey = '';

// Headers com o código de acesso (quando houver).
const authHeaders = () => (accessKey ? { 'x-eva-key': accessKey } : {});

function send(message) {
  chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
}
function status(text) {
  send({ type: 'CAPTURE_STATUS', status: text });
}
const pickMime = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

// --------------------------------------------------------------------------
// Captura e mixagem
// --------------------------------------------------------------------------
async function startCapture(streamId, opts) {
  backendUrl = opts.backendUrl;
  chunkMs = opts.chunkMs || 20000;
  accessKey = opts.accessKey || '';

  // 1) Áudio da aba.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // 2) Microfone (com cancelamento de eco/ruído por padrão -> reduz vazamento da aba).
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch {
    micStream = null;
    status('Microfone indisponível — gravando só o áudio da aba.');
  }

  // 3) AudioContext: mix (para o áudio completo) + devolver áudio da aba aos alto-falantes.
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination); // você continua ouvindo a reunião
  if (micStream) audioContext.createMediaStreamSource(micStream).connect(destination);

  mixedStream = destination.stream;
  sessionStartMs = Date.now();
  running = true;

  // 4) Canais de transcrição (cada um com um medidor de nível para detectar silêncio).
  channels = [];
  channels.push(makeChannel(opts.othersName || 'Participantes', tabStream));
  if (micStream) channels.push(makeChannel(opts.userName || 'Você', micStream));

  startFullRecorder();
  channels.forEach(startChannelRecorder);
  meterTimer = setInterval(updateMeters, 100);

  status(micStream ? 'Gravando (aba + microfone)…' : 'Gravando (aba)…');
}

// --------------------------------------------------------------------------
// Medidor de nível por canal (para pular blocos em silêncio)
// --------------------------------------------------------------------------
function makeChannel(speaker, stream) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  return {
    speaker,
    stream,
    analyser,
    buf: new Uint8Array(analyser.fftSize),
    recorder: null,
    blobs: [],
    startMs: 0,
    peak: 0,
    done: null,
    resolveDone: null,
  };
}

function updateMeters() {
  for (const ch of channels) {
    ch.analyser.getByteTimeDomainData(ch.buf);
    let m = 0;
    for (let i = 0; i < ch.buf.length; i++) {
      const d = Math.abs(ch.buf[i] - 128);
      if (d > m) m = d;
    }
    if (m > ch.peak) ch.peak = m;
  }
}

// --------------------------------------------------------------------------
// Gravação
// --------------------------------------------------------------------------
function startFullRecorder() {
  fullBlobs = [];
  fullRecorder = new MediaRecorder(mixedStream, { mimeType: pickMime() });
  fullDone = new Promise((resolve) => {
    fullRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) fullBlobs.push(e.data);
    };
    fullRecorder.onstop = () => resolve(new Blob(fullBlobs, { type: 'audio/webm' }));
  });
  fullRecorder.start(2000);
}

function startChannelRecorder(ch) {
  ch.blobs = [];
  ch.peak = 0;
  ch.startMs = Date.now() - sessionStartMs;
  ch.done = new Promise((resolve) => (ch.resolveDone = resolve));
  ch.recorder = new MediaRecorder(ch.stream, { mimeType: pickMime() });

  ch.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) ch.blobs.push(e.data);
  };

  ch.recorder.onstop = async () => {
    const endMs = Date.now() - sessionStartMs;
    const speaking = ch.peak >= SILENCE_THRESHOLD;
    const blob = new Blob(ch.blobs, { type: 'audio/webm' });
    if (speaking && blob.size > 1200) {
      await transcribeChunk(blob, ch.speaker, ch.startMs, endMs);
    }
    if (running) {
      startChannelRecorder(ch); // próximo bloco do mesmo canal
    } else {
      ch.resolveDone();
    }
  };

  ch.recorder.start();
  // Cada canal reinicia no seu próprio ciclo.
  ch.timer = setTimeout(() => {
    if (ch.recorder && ch.recorder.state !== 'inactive') ch.recorder.stop();
  }, chunkMs);
}

async function transcribeChunk(blob, speaker, startMs, endMs) {
  try {
    const form = new FormData();
    form.append('audio', blob, `chunk-${Date.now()}.webm`);
    const res = await fetch(`${backendUrl}/api/transcribe`, { method: 'POST', body: form, headers: authHeaders() });
    if (!res.ok) throw new Error(`transcribe ${res.status}`);
    const { text } = await res.json();
    if (text && text.trim()) {
      send({ type: 'TRANSCRIPT_SEGMENT', text: text.trim(), speaker, startMs, endMs });
    }
  } catch (err) {
    status(`Falha ao transcrever um bloco (${err.message}). Continuando…`);
  }
}

// --------------------------------------------------------------------------
// Fim da gravação
// --------------------------------------------------------------------------
async function stopCapture() {
  running = false;
  if (meterTimer) clearInterval(meterTimer);

  if (fullRecorder && fullRecorder.state !== 'inactive') fullRecorder.stop();
  channels.forEach((ch) => {
    if (ch.timer) clearTimeout(ch.timer);
    if (ch.recorder && ch.recorder.state !== 'inactive') ch.recorder.stop();
    else if (ch.resolveDone) ch.resolveDone();
  });

  await finishSession();
}

async function finishSession() {
  // Espera todos os canais e o gravador completo terminarem.
  await Promise.all(channels.map((ch) => ch.done));

  let audioId = null;
  try {
    status('Salvando áudio…');
    const blob = await fullDone;
    if (blob && blob.size > 1200) {
      const form = new FormData();
      form.append('audio', blob, `meeting-${Date.now()}.webm`);
      const res = await fetch(`${backendUrl}/api/audio`, { method: 'POST', body: form, headers: authHeaders() });
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
  fullRecorder = null;
  fullBlobs = [];
  channels = [];
}

// --------------------------------------------------------------------------
// Mensagens vindas do service worker
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'START_CAPTURE') {
    startCapture(message.streamId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        cleanup();
        send({ type: 'CAPTURE_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture().finally(() => sendResponse({ ok: true }));
    return true;
  }
});
