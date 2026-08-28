-- Tracker — Modern Hobbit LLC
-- Schema update v2 (Aug 12, 2026)
-- Adds: profile, per-exercise increments, warm-up sets, stretching, pilates
-- Paste into Supabase → SQL Editor → Run. Safe to run once; additive only.

-- 1. Per-exercise increment + warmup config (extend exercises table)
alter table exercises add column if not exists increment numeric default 5;
alter table exercises add column if not exists warmup boolean default false;

-- 2. Warm-up sets logged per lift (extend lifts table)
alter table lifts add column if not exists warmup_weight numeric;
alter table lifts add column if not exists warmup_reps int;

-- 3. Pilates on walk days (extend walks table)
alter table walks add column if not exists pilates boolean default false;
alter table walks add column if not exists pilates_mins int;

-- 4. User profile (one row per user)
create table if not exists profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  age int,
  height_in numeric,          -- height in inches
  start_weight numeric,       -- for progress baselines
  goal_weight numeric,
  goal_waist numeric,         -- the 34" target
  experience text,            -- e.g. returning / beginner / intermediate
  goals text,                 -- free text: "fat loss, keep muscle, Maximus not Thor"
  conditions text,            -- free text: injuries/limitations (feeds injury flags later)
  updated_at timestamptz not null default now()
);
alter table profile enable row level security;
create policy "own profile" on profile for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 5. Stretching completion per session (extend sessions table)
alter table sessions add column if not exists stretch_pre boolean default false;
alter table sessions add column if not exists stretch_post boolean default false;
