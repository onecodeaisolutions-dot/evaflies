// Offscreen document: grava o áudio da reunião (aba + microfone) e, AO PARAR,
// envia só o áudio para o backend GUARDAR — rápido, sem transcrever. A
// transcrição é sob demanda no painel (botão "Transcrever").

let audioContext = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;

let mixedRec = null;

let silenceTimer = null;
let stopping = false;
let running = false;
let sessionStartMs = 0;
let backendUrl = '';
let accessKey = '';
let title = 'Reunião';

// Áudio combinado (aba + microfone): serve para ouvir no painel E para a
// transcrição sob demanda. 48k dá boa precisão de transcrição e cabe ~1h folgado.
const MIXED_BPS = 48000;

// Fila de uploads em segundo plano: roda um de cada vez. Assim a próxima
// gravação não espera o upload da anterior, e evitamos dois uploads grandes
// simultâneos saturando a banda (causa do "Premature close").
let uploadChain = Promise.resolve();
function enqueueUpload(task) {
  uploadChain = uploadChain.then(task).catch(() => {});
}

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
      await sleep(delays[i]); // upload roda em segundo plano (sem status global)
    }
    const ctrl = new AbortController();
    // 10 min: cobre reuniões longas (corte em blocos + 2 canais). Como o envio é
    // idempotente (clientId), um retry após timeout não duplica a reunião.
    const timer = setTimeout(() => ctrl.abort(), 600000);
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
  const analyser = audioContext.createAnalyser(); // mede o nível p/ auto-parada
  analyser.fftSize = 2048;
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(dest);
  tabSource.connect(analyser);
  tabSource.connect(audioContext.destination); // você continua ouvindo
  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(dest);
    micSource.connect(analyser);
  }
  mixedStream = dest.stream;

  sessionStartMs = Date.now();
  running = true;
  stopping = false;

  // 4) Gravação contínua do áudio combinado.
  mixedRec = makeRecorder(mixedStream, MIXED_BPS);

  // 5) Auto-parada por silêncio (reunião encerrada sem fechar a aba).
  const autoStopMs = Number(opts.autoStopSilenceMin || 0) * 60000;
  if (autoStopMs > 0) startSilenceWatch(analyser, autoStopMs);

  status(micStream ? 'Gravando (aba + microfone)…' : 'Gravando (aba)…');
}

// Para sozinho após autoStopMs de silêncio total (ninguém falando).
function startSilenceWatch(analyser, autoStopMs) {
  const buf = new Float32Array(analyser.fftSize);
  let lastLoud = Date.now();
  silenceTimer = setInterval(() => {
    if (!running) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.01) {
      lastLoud = Date.now(); // alguém falou
    } else if (Date.now() - lastLoud >= autoStopMs) {
      const mins = Math.round(autoStopMs / 60000);
      status(`Sem áudio há ${mins} min — encerrando e transcrevendo…`);
      send({ type: 'CAPTURE_STOPPING' }); // avisa o background p/ congelar o tempo
      stopCapture();
    }
  }, 3000);
}

// --------------------------------------------------------------------------
// Fim: para tudo e manda para o backend processar.
// --------------------------------------------------------------------------
async function stopCapture() {
  if (stopping) return; // evita parar duas vezes (auto-parada + clique manual)
  stopping = true;
  running = false;
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
  if (mixedRec && mixedRec.rec.state !== 'inactive') mixedRec.rec.stop();

  status('Finalizando gravação…');

  // Captura os dados DESTA reunião antes que uma próxima gravação sobrescreva
  // as variáveis globais (title/sessionStartMs).
  const capTitle = title;
  let mixedBlob = null;
  let form = null;
  try {
    mixedBlob = await mixedRec.done;
    const durationMs = sessionStartMs ? Date.now() - sessionStartMs : 0;
    form = new FormData();
    if (mixedBlob && mixedBlob.size > 1200) form.append('mixed', mixedBlob, 'mixed.webm');
    form.append('title', capTitle);
    form.append('durationMs', String(durationMs));
    // Chave de idempotência: gerada UMA vez por reunião e reusada em todos os
    // retries. O servidor usa para não duplicar a reunião se a resposta se perder.
    form.append('clientId', crypto.randomUUID());
  } catch (err) {
    cleanup();
    send({ type: 'CAPTURE_ERROR', error: err.message }); // não houve upload p/ enfileirar
    return;
  }

  // Libera o microfone/aba AGORA: o dispositivo fica pronto para a próxima
  // reunião enquanto esta é enviada em segundo plano.
  cleanup();
  send({ type: 'CAPTURE_STOPPED' });

  enqueueUpload(async () => {
    let meeting = null;
    let errorMsg = null;
    try {
      await wakeServer();
      meeting = await postFinalize(form);
    } catch (err) {
      errorMsg = err.message;
      // Não conseguimos enviar: salva o áudio nos Downloads para não perder a reunião.
      if (mixedBlob && mixedBlob.size > 1200) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const saved = downloadBlob(mixedBlob, `evaflies-reuniao-${stamp}.webm`);
        if (saved) errorMsg = `${err.message} — áudio salvo em Downloads (você pode reenviar depois).`;
      }
    }
    send({ type: 'FINALIZE_DONE', meeting, error: errorMsg, title: capTitle });
  });
}

function cleanup() {
  [tabStream, micStream, mixedStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = mixedStream = tabStream = micStream = null;
  mixedRec = null;
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
