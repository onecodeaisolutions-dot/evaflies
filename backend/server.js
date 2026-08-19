// Servidor Express: proxy para a OpenAI (transcrição + resumo) e storage das reuniões.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGlobalDispatcher, Agent } from 'undici';

// O fetch nativo do Node (undici) às vezes derruba uploads grandes para a OpenAI
// com "Premature close" em hosts com rede instável (ex.: Render free). Um Agent
// com timeouts generosos e conexões novas (sem reaproveitar socket meio-fechado)
// torna o upload da transcrição muito mais confiável.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 30_000 },
    headersTimeout: 300_000,
    bodyTimeout: 300_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  })
);

import { transcribeVerbose, summarize, config } from './src/openai.js';
import {
  initStore,
  ping,
  listMeetings,
  getMeeting,
  getMeetingByShareId,
  getMeetingByClientId,
  createMeeting,
  updateMeeting,
  deleteMeeting,
} from './src/store.js';
import { initAudioStore, saveAudio, serveAudio, deleteAudio, loadAudio } from './src/audio-store.js';
import { storageMode } from './src/storage-config.js';
import { requireUser, ownerFilter, listOwnerFilter, listUsers, authEnabled } from './src/auth.js';

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

// Upload do ÁUDIO COMPLETO da reunião: em memória (vai para o storage), limite 200MB.
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Finalização: só o áudio da reunião. Limite 200MB (3h a 48kbps ≈ 65MB; folga
// para reuniões muito longas ou bitrates maiores).
const uploadFinalize = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Wrapper para capturar erros de handlers async.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// "Impressão digital" do áudio: hash sha256 dos bytes enviados. Serve como chave
// de idempotência quando a extensão não manda um clientId (versões antigas) —
// como o retry reenvia os mesmos bytes, o hash é idêntico e não duplica.
function audioFingerprint(...uploads) {
  const hash = crypto.createHash('sha256');
  let any = false;
  for (const f of uploads) {
    if (f && f.buffer && f.size > 1200) { hash.update(f.buffer); any = true; }
  }
  return any ? `sha256:${hash.digest('hex')}` : null;
}

// --- Health ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    storage: storageMode,
    auth: authEnabled,
    models: config,
  });
});

// Keep-alive: toca no banco para o Supabase free não pausar por inatividade.
app.get('/api/ping', wrap(async (req, res) => {
  await ping();
  res.json({ ok: true, storage: storageMode, ts: new Date().toISOString() });
}));

// Quem sou eu? Usado pelo painel para saber se precisa de login.
app.get('/api/me', requireUser, (req, res) => {
  res.json({ authEnabled, user: req.user });
});

// Lista de vendedores (admin ou supervisor) — alimenta o menu de filtro no
// painel. O supervisor recebe só quem ele supervisiona (admins ficam de fora).
app.get('/api/users', requireUser, (req, res) => {
  if (!req.user || (!req.user.admin && !req.user.supervisor)) {
    return res.status(403).json({ error: 'Apenas admin ou supervisor.' });
  }
  res.json(listUsers(req.user));
});

// --- Áudio completo da reunião -------------------------------------------
// Upload do áudio gravado (devolve um audioId para vincular à reunião).
app.post(
  '/api/audio',
  requireUser,
  uploadAudio.single('audio'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo no campo "audio".' });
    const audioId = await saveAudio(req.file.buffer, req.file.mimetype || 'audio/webm');
    res.status(201).json({ audioId });
  })
);

// Servir o áudio (local: arquivo com Range; Supabase: redirect para URL assinada).
// O <audio> não envia headers, então a chave pode vir por ?key= (tratada em requireUser).
app.get('/api/audio/:id', requireUser, wrap((req, res) =>
  serveAudio(res, req.params.id.replace(/\.webm$/, ''), { download: req.query.download })));

// --- Resumo de uma transcrição -------------------------------------------
app.post(
  '/api/summarize',
  wrap(async (req, res) => {
    const { transcript, title } = req.body || {};
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Campo "transcript" é obrigatório.' });
    }
    const result = await summarize(transcript, title);
    res.json(result);
  })
);

// --- Reuniões -------------------------------------------------------------
app.get('/api/meetings', requireUser, wrap(async (req, res) => {
  const { q, from, to } = req.query;
  const opts = {
    q: (q || '').trim() || null,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : null,
  };
  res.json(await listMeetings(listOwnerFilter(req), opts));
}));

app.get('/api/meetings/:id', requireUser, wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id, ownerFilter(req));
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  res.json(meeting);
}));

app.post('/api/meetings', requireUser, wrap(async (req, res) => {
  const { title, transcript, segments, durationMs, audioId, summarize: doSummarize } = req.body || {};

  let summary = null;
  if (doSummarize && transcript && transcript.trim()) {
    try {
      summary = await summarize(transcript, title);
    } catch (err) {
      console.error('Falha ao resumir:', err.message);
    }
  }

  const owner = req.user ? req.user.id : null;
  const meeting = await createMeeting({ title, transcript, segments, summary, durationMs, audioId, owner });
  res.status(201).json(meeting);
}));

// Finalização no FINAL da reunião: apenas SALVA o áudio e cria a reunião (rápido,
// SEM transcrever). A transcrição é sob demanda em /api/meetings/:id/transcribe.
app.post(
  '/api/meetings/finalize',
  requireUser,
  uploadFinalize.fields([
    { name: 'mixed', maxCount: 1 },
    { name: 'self', maxCount: 1 },
    { name: 'others', maxCount: 1 },
  ]),
  wrap(async (req, res) => {
    const files = req.files || {};
    const { title, durationMs, clientId } = req.body || {};

    // Usa o mixed (playback). Aceita self/others de extensões antigas, mas só
    // guarda um arquivo de áudio.
    const mixed = files.mixed?.[0] || files.self?.[0] || files.others?.[0];

    // Idempotência: evita duplicar a reunião quando a extensão reenvia (retry).
    // Extensões novas mandam clientId; sem ele, derivamos do hash do áudio.
    const idemKey = clientId || audioFingerprint(mixed, files.self?.[0], files.others?.[0]);
    if (idemKey) {
      const dup = await getMeetingByClientId(idemKey);
      if (dup) return res.status(200).json(dup);
    }

    let audioId = null;
    if (mixed && mixed.size > 1200) {
      audioId = await saveAudio(mixed.buffer, mixed.mimetype || 'audio/webm');
    }

    const owner = req.user ? req.user.id : null;
    const meeting = await createMeeting({
      title,
      transcript: '',
      segments: [],
      summary: null,
      durationMs: Number(durationMs) || 0,
      audioId,
      owner,
      clientId: idemKey,
    });
    res.status(201).json(meeting);
  })
);

// Transcrição SOB DEMANDA, em segundo plano: reuniões longas levam vários
// minutos (blocos de 20min transcritos em sequência) e estourariam o timeout de
// um request síncrono. O POST dispara o job e devolve 202; o painel acompanha
// pelo GET (progresso por bloco) até terminar.
// Jobs em memória: se o servidor reiniciar no meio, o job some e o painel volta
// a oferecer o botão — é só transcrever de novo.
const transcribeJobs = new Map(); // meetingId -> {state, current, total, error}

async function runTranscription(meeting) {
  const job = { state: 'running', current: 0, total: 0, error: null };
  transcribeJobs.set(meeting.id, job);
  try {
    const buffer = await loadAudio(meeting.audioId);
    const { segments, durationMs: measuredMs } = await transcribeVerbose(
      buffer, 'audio.webm', 'audio/webm',
      (current, total) => { job.current = current; job.total = total; }
    );

    const transcript = segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n');
    let summary = null;
    if (transcript.trim()) {
      try {
        summary = await summarize(transcript, meeting.title);
      } catch (err) {
        console.error('Falha ao resumir:', err.message);
      }
    }

    // Conserta a duração se ela tiver vindo zerada (ex.: áudio reenviado manualmente).
    const patch = { transcript, segments, summary };
    if (!meeting.durationMs && measuredMs) patch.durationMs = measuredMs;
    await updateMeeting(meeting.id, patch);
    transcribeJobs.delete(meeting.id); // done: o GET passa a responder pela reunião
  } catch (err) {
    console.error(`Transcrição da reunião ${meeting.id} falhou:`, err);
    job.state = 'error';
    job.error = `Falha na transcrição: ${err.message}`;
  }
}

app.post('/api/meetings/:id/transcribe', requireUser, wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id, ownerFilter(req));
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  if (meeting.segments && meeting.segments.length) return res.json(meeting); // já transcrita
  if (!meeting.audioId) return res.status(400).json({ error: 'Esta reunião não tem áudio para transcrever.' });

  const existing = transcribeJobs.get(meeting.id);
  if (existing && existing.state === 'running') {
    return res.status(202).json(existing); // já está rodando: só acompanhar
  }
  runTranscription(meeting); // sem await: roda em segundo plano
  res.status(202).json({ state: 'running', current: 0, total: 0 });
}));

// Status da transcrição (polling do painel).
app.get('/api/meetings/:id/transcribe', requireUser, wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id, ownerFilter(req));
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  if (meeting.segments && meeting.segments.length) return res.json({ state: 'done' });
  res.json(transcribeJobs.get(meeting.id) || { state: 'idle' });
}));

app.patch('/api/meetings/:id', requireUser, wrap(async (req, res) => {
  // Garante que o usuário só altera reuniões que pode ver.
  const existing = await getMeeting(req.params.id, ownerFilter(req));
  if (!existing) return res.status(404).json({ error: 'Reunião não encontrada.' });
  // Só permitimos renomear (título) por aqui.
  const patch = {};
  if (typeof req.body?.title === 'string') patch.title = req.body.title.trim() || existing.title;
  const updated = await updateMeeting(req.params.id, patch);
  res.json(updated);
}));

app.delete('/api/meetings/:id', requireUser, wrap(async (req, res) => {
  const owner = ownerFilter(req);
  const meeting = await getMeeting(req.params.id, owner);
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  if (meeting.audioId) {
    try { await deleteAudio(meeting.audioId); } catch (err) { console.error('Falha ao apagar áudio:', err.message); }
  }
  await deleteMeeting(req.params.id, owner);
  res.json({ ok: true });
}));

// --- Compartilhamento público de uma reunião ------------------------------
// O dono gera um token secreto (link compartilhável). Quem tiver o link acessa
// só aquela reunião (áudio + transcrição + resumo), sem login.
app.post('/api/meetings/:id/share', requireUser, wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id, ownerFilter(req));
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  let shareId = meeting.shareId;
  if (!shareId) {
    shareId = crypto.randomBytes(16).toString('hex'); // 128 bits, não enumerável
    await updateMeeting(meeting.id, { shareId });
  }
  res.json({ shareId });
}));

// Revoga o link (quem tiver o token antigo perde o acesso).
app.delete('/api/meetings/:id/share', requireUser, wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id, ownerFilter(req));
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  await updateMeeting(meeting.id, { shareId: null });
  res.json({ ok: true });
}));

// Acesso PÚBLICO (sem login) via token. Devolve só o necessário, sem expor o dono.
app.get('/api/share/:token', wrap(async (req, res) => {
  const m = await getMeetingByShareId(req.params.token);
  if (!m) return res.status(404).json({ error: 'Link inválido ou revogado.' });
  res.json({
    title: m.title,
    createdAt: m.createdAt,
    durationMs: m.durationMs,
    segments: m.segments || [],
    summary: m.summary || null,
    hasAudio: Boolean(m.audioId),
  });
}));

// Áudio público via token (o <audio> não envia headers; o token vai na URL).
app.get('/api/share/:token/audio', wrap(async (req, res) => {
  const m = await getMeetingByShareId(req.params.token);
  if (!m || !m.audioId) return res.status(404).json({ error: 'Áudio não encontrado.' });
  return serveAudio(res, m.audioId);
}));

// --- Painel web (dashboard estilo Fireflies) ------------------------------
app.use(express.static(PUBLIC_DIR));

// --- Tratamento de erros --------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo de áudio grande demais (limite: 200MB).' });
  }
  // O supabase-js devolve só "fetch failed" quando não alcança o projeto (URL
  // errada, projeto pausado ou excluído). Sem contexto, quem vê o alerta no
  // painel não tem como saber o que checar.
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(String(err?.message || ''))) {
    return res.status(502).json({
      error:
        'Não consegui falar com o Supabase. Verifique SUPABASE_URL e ' +
        'SUPABASE_SERVICE_ROLE_KEY no Render, e se o projeto ainda está ativo.',
    });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Erro interno.' });
});

app.listen(PORT, () => {
  console.log(`EvaFlies backend rodando em http://localhost:${PORT} (storage: ${storageMode})`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY não configurada — defina em backend/.env');
  }
});

// Inicializa o storage em background — não bloqueia o start do servidor.
(async () => {
  try {
    await initAudioStore();
    await initStore();
  } catch (err) {
    console.warn('⚠️  Falha ao inicializar o storage:', err.message);
  }
})();
