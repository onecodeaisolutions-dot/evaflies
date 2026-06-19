// Offscreen document: grava o áudio da reunião e, AO PARAR, envia tudo para o
// backend transcrever de uma vez (melhor qualidade). Sem transcrição ao vivo.
//
// Três gravações contínuas:
//   - mixed (aba + microfone) -> áudio para ouvir no painel;
//   - self  (microfone)        -> canal do vendedor (transcrição);
//   - others (aba)             -> canal do cliente (transcrição).

let audioContext = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;

let mixedRec = null;
let micRec = null;
let tabRec = null;

let running = false;
let sessionStartMs = 0;
let backendUrl = '';
let accessKey = '';
let selfName = 'Você';
let othersName = 'Cliente';
let title = 'Reunião';

const MIXED_BPS = 32000; // áudio de playback (voz)
const CHANNEL_BPS = 24000; // canais p/ transcrição (leve, cabe no limite da API)

function send(message) {
  chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
}
const status = (text) => send({ type: 'CAPTURE_STATUS', status: text });
const authHeaders = () => (accessKey ? { 'x-eva-key': accessKey } : {});
const pickMime = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acorda o servidor (o Render free "dorme" e o 1º request pode demorar/falhar).
async function wakeServer() {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`${backendUrl}/api/health`, { method: 'GET' });
      if (r.ok) return;
    } catch { /* ainda acordando */ }
    await sleep(3000);
  }
}

// Envia a finalização com retry + timeout (cobre cold start e falhas passageiras).
async function postFinalize(form) {
  const url = `${backendUrl}/api/meetings/finalize`;
  const delays = [0, 5000, 15000, 30000];
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) {
      status(`Tentando novamente em alguns segundos… (${i + 1}/${delays.length})`);
      await sleep(delays[i]);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000); // transcreve 2 canais em sequência
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: form,
        headers: authHeaders(),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 || res.status === 429) {
        const body = await res.text().catch(() => '');
        throw new Error(`servidor ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`finalize ${res.status}: ${body.slice(0, 140)}`); // 4xx: não adianta repetir
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // erros de cliente (4xx) não se resolvem com retry.
      if (/finalize 4\d\d/.test(err.message)) break;
    }
  }
  throw lastErr || new Error('falha ao finalizar');
}

// Último recurso: salva o áudio nos Downloads para o vendedor não perder a reunião.
function downloadBlob(blob, name) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  } catch {
    return false;
  }
}

// Cria um gravador contínuo e uma Promise que resolve com o Blob ao parar.
function makeRecorder(stream, bps) {
  const blobs = [];
  const rec = new MediaRecorder(stream, { mimeType: pickMime(), audioBitsPerSecond: bps });
  const done = new Promise((resolve) => {
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) blobs.push(e.data); };
    rec.onstop = () => resolve(new Blob(blobs, { type: 'audio/webm' }));
  });
  rec.start(5000); // emite pedaços a cada 5s (mesma sessão = arquivo válido)
  return { rec, done };
}

// --------------------------------------------------------------------------
// Captura
// --------------------------------------------------------------------------
async function startCapture(streamId, opts) {
  backendUrl = opts.backendUrl;
  accessKey = opts.accessKey || '';
  selfName = opts.userName || 'Você';
  othersName = opts.othersName || 'Cliente';
  title = opts.tabTitle || 'Reunião';

  // 1) Áudio da aba.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // 2) Microfone (com cancelamento de eco/ruído).
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch {
    micStream = null;
    status('Microfone indisponível — gravando só o áudio da aba.');
  }

  // 3) Mix para o áudio de playback + devolver a aba aos alto-falantes.
  audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(dest);
  tabSource.connect(audioContext.destination); // você continua ouvindo
  if (micStream) audioContext.createMediaStreamSource(micStream).connect(dest);
  mixedStream = dest.stream;

  sessionStartMs = Date.now();
  running = true;

  // 4) Gravações contínuas.
  mixedRec = makeRecorder(mixedStream, MIXED_BPS);
  tabRec = makeRecorder(tabStream, CHANNEL_BPS);
  micRec = micStream ? makeRecorder(micStream, CHANNEL_BPS) : null;

  status(micStream ? 'Gravando (aba + microfone)…' : 'Gravando (aba)…');
}

// --------------------------------------------------------------------------
// Fim: para tudo e manda para o backend processar.
// --------------------------------------------------------------------------
async function stopCapture() {
  running = false;
  [mixedRec, micRec, tabRec].forEach((r) => {
    if (r && r.rec.state !== 'inactive') r.rec.stop();
  });

  let meeting = null;
  let errorMsg = null;
  let mixedBlob = null;
  try {
    status('Finalizando gravação…');
    mixedBlob = await mixedRec.done;
    const othersBlob = await tabRec.done;
    const selfBlob = micRec ? await micRec.done : null;

    const durationMs = sessionStartMs ? Date.now() - sessionStartMs : 0;
    const form = new FormData();
    if (mixedBlob && mixedBlob.size > 1200) form.append('mixed', mixedBlob, 'mixed.webm');
    if (selfBlob && selfBlob.size > 1200) form.append('self', selfBlob, 'self.webm');
    if (othersBlob && othersBlob.size > 1200) form.append('others', othersBlob, 'others.webm');
    form.append('title', title);
    form.append('selfName', selfName);
    form.append('othersName', othersName);
    form.append('durationMs', String(durationMs));
    form.append('summarize', 'true');

    status('Conectando ao servidor…');
    await wakeServer();
    status('Transcrevendo no servidor… (pode levar até ~1 min)');
    meeting = await postFinalize(form);
  } catch (err) {
    errorMsg = err.message;
    // Não conseguimos enviar: salva o áudio localmente para não perder a reunião.
    if (mixedBlob && mixedBlob.size > 1200) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const saved = downloadBlob(mixedBlob, `evaflies-reuniao-${stamp}.webm`);
      if (saved) errorMsg = `${err.message} — áudio salvo em Downloads (você pode reenviar depois).`;
    }
  }

  cleanup();
  send({ type: 'CAPTURE_STOPPED', meeting, error: errorMsg });
}

function cleanup() {
  [tabStream, micStream, mixedStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = mixedStream = tabStream = micStream = null;
  mixedRec = micRec = tabRec = null;
}

// --------------------------------------------------------------------------
// Mensagens do service worker
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'START_CAPTURE') {
    startCapture(message.streamId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        cleanup();
        send({ type: 'CAPTURE_STOPPED', meeting: null, error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture().finally(() => sendResponse({ ok: true }));
    return true;
  }
});
