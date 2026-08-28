-- Tracker — Modern Hobbit LLC
-- Schema update v3 (Aug 21, 2026) — Food diary
-- Adds: foods (staple/library definitions) + food_log (daily entries)
-- Paste into Supabase → SQL Editor → Run. Additive only; safe.

-- Staple/defined foods & meals — define once, log many times.
-- Nutrients stored per SERVING as the user defines them.
-- source: 'custom' (user-entered) | 'usda' (looked up) | 'ai' (Claude-parsed) — for later
create table if not exists foods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  serving text,                 -- freeform serving description, e.g. "1 sandwich", "2 eggs"
  is_meal boolean default false,-- true = composite meal (rotation staple), false = single food
  source text default 'custom',
  usda_fdc_id text,             -- FoodData Central id when source='usda' (future)
  -- core four (always shown)
  calories numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  fiber numeric,
  -- optional / toggleable nutrients
  sodium numeric,               -- mg
  added_sugar numeric,          -- g
  sat_fat numeric,              -- g
  cholesterol numeric,          -- mg
  potassium numeric,            -- mg
  archived boolean default false,
  created_at timestamptz not null default now()
);
create index foods_by_user on foods (user_id, archived, name);

-- One row per logged food entry on a given day.
-- Denormalizes the nutrient values at log time (so editing a staple later
-- doesn't rewrite history), scaled by qty.
create table if not exists food_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  food_id uuid references foods(id) on delete set null, -- null if freeform/ai one-off
  name text not null,           -- snapshot of what was logged
  meal_slot text,               -- breakfast | lunch | dinner | snack (optional)
  qty numeric default 1,        -- servings multiplier
  source text default 'custom',
  -- snapshot nutrient values (already scaled by qty), so history is immutable
  calories numeric, protein numeric, carbs numeric, fat numeric, fiber numeric,
  sodium numeric, added_sugar numeric, sat_fat numeric, cholesterol numeric, potassium numeric,
  created_at timestamptz not null default now()
);
create index foodlog_by_day on food_log (user_id, date);

-- Daily targets + which optional nutrients the user wants visible.
-- Stored on the profile table (one row per user, already exists).
alter table profile add column if not exists target_calories numeric;
alter table profile add column if not exists target_protein numeric;
alter table profile add column if not exists target_carbs numeric;
alter table profile add column if not exists target_fat numeric;
alter table profile add column if not exists target_fiber numeric;
-- JSON array of optional nutrient keys the user has toggled on,
-- e.g. ["sodium","added_sugar"].  Default shows none of the optionals.
alter table profile add column if not exists nutrient_prefs jsonb default '[]'::jsonb;

-- RLS
alter table foods enable row level security;
alter table food_log enable row level security;
create policy "own foods" on foods for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own food_log" on food_log for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
