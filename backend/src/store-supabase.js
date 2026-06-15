// Armazenamento das reuniões no Postgres do Supabase.
// Tabela esperada: ver backend/supabase-schema.sql
import { supabase } from './storage-config.js';

const TABLE = 'meetings';

function toMeeting(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    transcript: row.transcript || '',
    segments: row.segments || [],
    summary: row.summary || null,
    durationMs: row.duration_ms || 0,
    audioId: row.audio_id || null,
    owner: row.owner || null,
    createdAt: row.created_at,
  };
}

export async function initStore() {
  // Verifica se a tabela existe / está acessível.
  const { error } = await supabase().from(TABLE).select('id').limit(1);
  if (error) {
    console.warn(
      `⚠️  Não consegui acessar a tabela "${TABLE}" no Supabase: ${error.message}\n` +
      '    Rode o SQL de backend/supabase-schema.sql no SQL Editor do Supabase.'
    );
  }
}

export async function listMeetings(ownerId) {
  // Não selecionamos a coluna "owner" aqui para manter compatibilidade caso
  // ela ainda não exista; o filtro por dono só roda quando a auth está ligada.
  let query = supabase()
    .from(TABLE)
    .select('id,title,summary,duration_ms,audio_id,created_at,transcript')
    .order('created_at', { ascending: false });
  if (ownerId) query = query.eq('owner', ownerId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary || null,
    durationMs: r.duration_ms || 0,
    audioId: r.audio_id || null,
    createdAt: r.created_at,
    hasAudio: Boolean(r.audio_id),
    transcriptPreview: (r.transcript || '').slice(0, 200),
  }));
}

export async function getMeeting(id, ownerId) {
  let query = supabase().from(TABLE).select('*').eq('id', id);
  if (ownerId) query = query.eq('owner', ownerId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return toMeeting(data);
}

export async function createMeeting({ title, transcript, segments, summary, durationMs, audioId, owner }) {
  const row = {
    title: title || `Reunião ${new Date().toLocaleString('pt-BR')}`,
    transcript: transcript || '',
    segments: Array.isArray(segments) ? segments : [],
    summary: summary || null,
    duration_ms: durationMs || 0,
    audio_id: audioId || null,
  };
  // Só inclui "owner" quando houver — assim funciona mesmo antes de criar a coluna.
  if (owner) row.owner = owner;
  const { data, error } = await supabase().from(TABLE).insert(row).select().single();
  if (error) throw error;
  return toMeeting(data);
}

export async function updateMeeting(id, patch) {
  const map = {
    title: 'title',
    transcript: 'transcript',
    segments: 'segments',
    summary: 'summary',
    durationMs: 'duration_ms',
    audioId: 'audio_id',
  };
  const row = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (map[k]) row[map[k]] = v;
  }
  if (!Object.keys(row).length) return getMeeting(id);
  const { data, error } = await supabase().from(TABLE).update(row).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return toMeeting(data);
}
