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
    shareId: row.share_id || null,
    clientId: row.client_id || null,
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

/** Consulta mínima no Postgres (keep-alive — evita o projeto pausar). */
export async function ping() {
  const { error } = await supabase().from(TABLE).select('id').limit(1);
  if (error) throw error;
  return true;
}

export async function listMeetings(ownerId, opts = {}) {
  // Não selecionamos a coluna "owner" aqui para manter compatibilidade caso
  // ela ainda não exista; o filtro por dono só roda quando a auth está ligada.
  let query = supabase()
    .from(TABLE)
    .select('id,title,summary,duration_ms,audio_id,created_at,transcript,owner')
    .order('created_at', { ascending: false });
  if (ownerId) query = query.eq('owner', ownerId);
  if (opts.from) query = query.gte('created_at', opts.from);
  if (opts.to) query = query.lte('created_at', opts.to);
  if (opts.q) {
    // Remove caracteres que quebram a sintaxe do filtro .or()
    const safe = opts.q.replace(/[,()%]/g, ' ').trim();
    if (safe) query = query.or(`title.ilike.%${safe}%,transcript.ilike.%${safe}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary || null,
    durationMs: r.duration_ms || 0,
    audioId: r.audio_id || null,
    owner: r.owner || null,
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

export async function createMeeting({ title, transcript, segments, summary, durationMs, audioId, owner, clientId }) {
  // Idempotência: se já existe uma reunião com este clientId, devolve-a.
  if (clientId) {
    const existing = await getMeetingByClientId(clientId);
    if (existing) return existing;
  }
  const row = {
    title: title || `Reunião ${new Date().toLocaleString('pt-BR')}`,
    transcript: transcript || '',
    segments: Array.isArray(segments) ? segments : [],
    summary: summary || null,
    duration_ms: durationMs || 0,
    audio_id: audioId || null,
  };
  // Só inclui "owner"/"client_id" quando houver — funciona mesmo antes de criar a coluna.
  if (owner) row.owner = owner;
  if (clientId) row.client_id = clientId;
  const { data, error } = await supabase().from(TABLE).insert(row).select().single();
  if (error) {
    // Corrida: outra requisição (retry simultâneo) criou primeiro -> devolve a dela.
    if (error.code === '23505' && clientId) {
      const dup = await getMeetingByClientId(clientId);
      if (dup) return dup;
    }
    throw error;
  }
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
    shareId: 'share_id',
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

export async function getMeetingByShareId(shareId) {
  if (!shareId) return null;
  const { data, error } = await supabase().from(TABLE).select('*').eq('share_id', shareId).maybeSingle();
  if (error) throw error;
  return toMeeting(data);
}

export async function getMeetingByClientId(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabase().from(TABLE).select('*').eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  return toMeeting(data);
}

export async function deleteMeeting(id, ownerId) {
  let query = supabase().from(TABLE).delete().eq('id', id);
  if (ownerId) query = query.eq('owner', ownerId);
  const { error } = await query;
  if (error) throw error;
  return true;
}
