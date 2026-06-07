// Servidor Express: proxy para a OpenAI (transcrição + resumo) e storage das reuniões.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { transcribe, summarize, config } from './src/openai.js';
import {
  listMeetings,
  getMeeting,
  createMeeting,
  updateMeeting,
} from './src/store.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

// Upload de áudio em memória. Limite de 25MB (limite da API de transcrição).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Wrapper para capturar erros de handlers async.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Health ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
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
  const { title, transcript, durationMs, summarize: doSummarize } = req.body || {};

  let summary = null;
  if (doSummarize && transcript && transcript.trim()) {
    try {
      summary = await summarize(transcript, title);
    } catch (err) {
      console.error('Falha ao resumir:', err.message);
    }
  }

  const meeting = await createMeeting({ title, transcript, summary, durationMs });
  res.status(201).json(meeting);
}));

app.patch('/api/meetings/:id', wrap(async (req, res) => {
  const updated = await updateMeeting(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Reunião não encontrada.' });
  res.json(updated);
}));

// --- Tratamento de erros --------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Erro interno.' });
});

app.listen(PORT, () => {
  console.log(`EvaFlies backend rodando em http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY não configurada — defina em backend/.env');
  }
});
