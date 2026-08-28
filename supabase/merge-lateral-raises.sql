-- Tracker — one-time data merge (Aug 12, 2026)
-- Heals the split "Lateral raises" (Day A) + "Lateral Raises (light)" (Day B)
-- into a single canonical "Lateral Raises" so progression history unifies.
--
-- SAFE TO RUN ONCE. Brad exported a backup first (Data tab → Export).
-- Run this in Supabase → SQL Editor AFTER schema-update-v2.sql and AFTER deploying v1.2.

-- 1. Rename the exercise rows (the per-day list entries)
update exercises
  set name = 'Lateral Raises'
  where name in ('Lateral raises', 'Lateral Raises (light)');

-- 2. Rename all logged lifts so their history merges under one name
update lifts
  set name = 'Lateral Raises'
  where name in ('Lateral raises', 'Lateral Raises (light)');

-- 3. Set a sensible increment (2.5 lb) on the now-canonical exercise rows
update exercises
  set increment = 2.5
  where name = 'Lateral Raises';

-- Verify (optional): should show only 'Lateral Raises' now
-- select distinct name from exercises where name ilike '%lateral%';
-- select distinct name from lifts where name ilike '%lateral%';
