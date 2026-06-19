// Servidor Express: proxy para a OpenAI (transcrição + resumo) e storage das reuniões.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcribe, transcribeVerbose, summarize, config } from './src/openai.js';
import {
  initStore,
  ping,
  listMeetings,
  getMeeting,
  createMeeting,
  updateMeeting,
  deleteMeeting,
} from './src/store.js';
import { initAudioStore, saveAudio, serveAudio, deleteAudio } from './src/audio-store.js';
import { storageMode } from './src/storage-config.js';
import { requireUser, ownerFilter, listOwnerFilter, listUsers, authEnabled } from './src/auth.js';

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

// Upload de BLOCO para transcrição: em memória, limite 25MB (limite da OpenAI).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Upload do ÁUDIO COMPLETO da reunião: em memória (vai para o storage), limite 200MB.
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Finalização (novo fluxo): áudio mixado + 2 canais. Limite por arquivo 40MB.
const uploadFinalize = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

// Wrapper para capturar erros de handlers async.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// Lista de vendedores (apenas admin) — alimenta o menu de filtro no painel.
app.get('/api/users', requireUser, (req, res) => {
  if (!req.user || !req.user.admin) return res.status(403).json({ error: 'Apenas admin.' });
  res.json(listUsers());
});

// --- Transcrição de um bloco ---------------------------------------------
app.post(
  '/api/transcribe',
  requireUser,
  upload.single('audio'),
  wrap(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Envie um arquivo no campo "audio".' });
    }
    const filename = req.file.originalname || 'chunk.webm';
    const text = await transcribe(req.file.buffer, filename, req.file.mimetype);
    res.json({ text });
  })
);

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
app.get('/api/audio/:id', requireUser, wrap((req, res) => serveAudio(res, req.params.id.replace(/\.webm$/, ''))));

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

// Finalização no FINAL da reunião: recebe o áudio mixado (playback) + os dois
// canais (vendedor/cliente), transcreve cada canal inteiro com timestamps,
// intercala por tempo, resume e cria a reunião. (Fluxo da extensão 1.1+.)
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
    const { title, selfName, othersName, durationMs } = req.body || {};
    const wantSummary = req.body?.summarize !== 'false';

    // 1) Salva o áudio mixado (para reprodução no painel).
    let audioId = null;
    const mixed = files.mixed?.[0];
    if (mixed && mixed.size > 1200) {
      audioId = await saveAudio(mixed.buffer, mixed.mimetype || 'audio/webm');
    }

    // 2) Transcreve os dois canais em paralelo, cada um com seu falante.
    const jobs = [];
    const sf = files.self?.[0];
    const ot = files.others?.[0];
    jobs.push(
      sf && sf.size > 1200
        ? transcribeVerbose(sf.buffer, 'self.webm').then((segs) =>
            segs.map((s) => ({ ...s, speaker: selfName || 'Você' })))
        : Promise.resolve([])
    );
    jobs.push(
      ot && ot.size > 1200
        ? transcribeVerbose(ot.buffer, 'others.webm').then((segs) =>
            segs.map((s) => ({ ...s, speaker: othersName || 'Cliente' })))
        : Promise.resolve([])
    );
    const [selfSegs, otherSegs] = await Promise.all(jobs);

    let segments = [...selfSegs, ...otherSegs].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    // Reenvio de áudio salvo: só veio o arquivo mixado -> transcreve sem separar.
    if (!segments.length && mixed && mixed.size > 1200) {
      const segs = await transcribeVerbose(mixed.buffer, 'mixed.webm');
      segments = segs.map((s) => ({ ...s, speaker: null }));
    }
    const transcript = segments
      .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
      .join('\n');

    // 3) Resumo.
    let summary = null;
    if (wantSummary && transcript.trim()) {
      try {
        summary = await summarize(transcript, title);
      } catch (err) {
        console.error('Falha ao resumir:', err.message);
      }
    }

    const owner = req.user ? req.user.id : null;
    const meeting = await createMeeting({
      title,
      transcript,
      segments,
      summary,
      durationMs: Number(durationMs) || 0,
      audioId,
      owner,
    });
    res.status(201).json(meeting);
  })
);

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

// --- Painel web (dashboard estilo Fireflies) ------------------------------
app.use(express.static(PUBLIC_DIR));

// --- Tratamento de erros --------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Erro:', err);
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
