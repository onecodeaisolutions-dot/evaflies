-- Schema do EvaFlies para o Supabase (Postgres).
-- Rode este SQL uma vez no SQL Editor do Supabase.

create extension if not exists "pgcrypto";

create table if not exists public.meetings (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Reunião',
  transcript  text not null default '',
  segments    jsonb not null default '[]'::jsonb,   -- [{startMs,endMs,text,speaker}]
  summary     jsonb,                                 -- {summary, action_items, topics}
  duration_ms bigint not null default 0,
  audio_id    text,                                  -- nome do arquivo no Storage
  owner       text,                                  -- dono da reunião (separação por vendedor)
  created_at  timestamptz not null default now()
);

-- Se a tabela já existir (criada antes), adiciona a coluna owner:
alter table public.meetings add column if not exists owner text;

-- Compartilhamento público por token (link compartilhável de uma reunião):
alter table public.meetings add column if not exists share_id text;

-- Chave de idempotência do cliente (evita reuniões duplicadas no retry de envio):
alter table public.meetings add column if not exists client_id text;

create index if not exists meetings_created_at_idx on public.meetings (created_at desc);
create index if not exists meetings_owner_idx on public.meetings (owner);
-- Lookup rápido pelo token + garante unicidade (vários NULLs são permitidos):
create unique index if not exists meetings_share_id_idx on public.meetings (share_id);
-- Unicidade da chave de idempotência (trava duplicatas mesmo em retry simultâneo):
create unique index if not exists meetings_client_id_idx on public.meetings (client_id);

-- O bucket de áudio ("meeting-audio") é criado automaticamente pelo backend na
-- inicialização. Se preferir criar manualmente: Storage -> New bucket ->
-- nome "meeting-audio", Private. O backend acessa via service role key.
