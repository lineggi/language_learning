-- Daybreak Wire — Supabase schema
-- Run this once in your Supabase project: SQL Editor → paste → Run.
-- Re-running it is safe: every statement is idempotent, so an existing project
-- can be upgraded by pasting the whole file again.
--
-- Storage model: one row per user holding the whole app state as JSONB.
-- The dataset is tiny (a wordbank object, a reads object, a streak object, an
-- 오답노트 object and the 영작 answers), so a single-row-per-user blob is the
-- simplest reliable way to sync across devices. Row Level Security ensures each
-- user only sees their own row.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  wordbank   jsonb not null default '{}'::jsonb,
  reads      jsonb not null default '{}'::jsonb,
  streak     jsonb not null default '{"count":0,"lastDate":null}'::jsonb,
  -- 오답노트: grammar mistakes lifted from AI corrections, with their SRS stage.
  errors     jsonb not null default '{}'::jsonb,
  -- 영작: the learner's answers + AI feedback, keyed by pack id.
  writing    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Upgrade path for projects created before these two columns existed.
alter table public.user_state add column if not exists errors  jsonb not null default '{}'::jsonb;
alter table public.user_state add column if not exists writing jsonb not null default '{}'::jsonb;

alter table public.user_state enable row level security;

-- A user may read / insert / update ONLY their own row.
drop policy if exists "user_state_select_own" on public.user_state;
create policy "user_state_select_own"
  on public.user_state for select
  using (auth.uid() = user_id);

drop policy if exists "user_state_insert_own" on public.user_state;
create policy "user_state_insert_own"
  on public.user_state for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_state_update_own" on public.user_state;
create policy "user_state_update_own"
  on public.user_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
