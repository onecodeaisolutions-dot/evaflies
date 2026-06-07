// Servidor Express: proxy para a OpenAI (transcrição + resumo) e storage das reuniões.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { transcribe, summarize, config } from './src/openai.js';
import {
  initStore,
  listMeetings,
  getMeeting,
  createMeeting,
  updateMeeting,
} from './src/store.js';
import { initAudioStore, saveAudio, serveAudio } from './src/audio-store.js';
import { storageMode } from './src/storage-config.js';

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

// Wrapper para capturar erros de handlers async.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Health ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    storage: storageMode,
    models: config,
  });
});

// --- Transcrição de um bloco ---------------------------------------------
app.post(
  '/api/transcribe',
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
  uploadAudio.single('audio'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo no campo "audio".' });
    const audioId = await saveAudio(req.file.buffer, req.file.mimetype || 'audio/webm');
    res.status(201).json({ audioId });
  })
);

// Servir o áudio (local: arquivo com Range; Supabase: redirect para URL assinada).
app.get('/api/audio/:id', wrap((req, res) => serveAudio(res, req.params.id.replace(/\.webm$/, ''))));

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
app.get('/api/meetings', wrap(async (req, res) => {
  res.json(await listMeetings());
}));

app.get('/api/meetings/:id', wrap(async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  res.json(meeting);
}));

app.post('/api/meetings', wrap(async (req, res) => {
  const { title, transcript, segments, durationMs, audioId, summarize: doSummarize } = req.body || {};

  let summary = null;
  if (doSummarize && transcript && transcript.trim()) {
    try {
      summary = await summarize(transcript, title);
    } catch (err) {
      console.error('Falha ao resumir:', err.message);
    }
  }

  const meeting = await createMeeting({ title, transcript, segments, summary, durationMs, audioId });
  res.status(201).json(meeting);
}));

app.patch('/api/meetings/:id', wrap(async (req, res) => {
  const updated = await updateMeeting(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Reunião não encontrada.' });
  res.json(updated);
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
