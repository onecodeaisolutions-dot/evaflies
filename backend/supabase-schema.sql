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
  created_at  timestamptz not null default now()
);

create index if not exists meetings_created_at_idx on public.meetings (created_at desc);

-- O bucket de áudio ("meeting-audio") é criado automaticamente pelo backend na
-- inicialização. Se preferir criar manualmente: Storage -> New bucket ->
-- nome "meeting-audio", Private. O backend acessa via service role key.
