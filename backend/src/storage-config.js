// Configuração de armazenamento. Se SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// estiverem definidos, usamos Supabase (Postgres + Storage). Caso contrário,
// caímos no modo arquivo local (bom para desenvolvimento offline).
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Sanitiza: remove espaços/quebras de linha e barras finais (causam
// "Invalid path specified in request URL" quando há barra dupla na URL).
export const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
export const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
export const SUPABASE_BUCKET = (process.env.SUPABASE_BUCKET || 'meeting-audio').trim();
export const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const storageMode = useSupabase ? 'supabase' : 'file';

let _client = null;

/** Client do Supabase (service role — uso server-side, ignora RLS). */
export function supabase() {
  if (!useSupabase) throw new Error('Supabase não configurado.');
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Não usamos realtime; fornecemos um WebSocket via "ws" para o cliente
      // funcionar em Node < 22 (que não tem WebSocket nativo global).
      realtime: { transport: WebSocket },
    });
  }
  return _client;
}
