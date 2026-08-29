# Tracker v1.0 — Web Edition
*Modern Hobbit LLC*

The real thing: Tracker with a real database, real login, and progression that follows each exercise across all three days. Setup is ~20 minutes.

## What you need
- A Supabase account (free) — supabase.com
- A Netlify account (free) — you already have one from Scout

## Setup

### 1. Create the database
1. supabase.com → New project (name it `tracker`, pick a region near you, set a database password — save it somewhere, you won't need it daily)
2. Wait ~1 minute for the project to spin up
3. Left sidebar → **SQL Editor** → New query → paste the entire contents of `schema.sql` → **Run**
4. You should see "Success. No rows returned"

### 2. Turn off email confirmation (for now)
Authentication → Sign In / Up → Email → toggle **off** "Confirm email".
(Just so your first sign-up works instantly. Turn it back on before any public launch.)

### 3. Connect the app to your database
1. Supabase → Project Settings (gear icon) → **API**
2. Copy the **Project URL** and the **anon public** key
3. Open `config.js` in this folder and paste both values in

### 4. Deploy
Easiest: Netlify dashboard → **Add new site → Deploy manually** → drag this whole folder in.
Done. You'll get a URL like `something.netlify.app` (rename it in Site settings → Change site name, e.g. `mh-tracker`).

### 5. First run
1. Open your site URL → **Create account** with your email + a password
2. The app seeds your three days (A/B/C) with your current exercises automatically
3. **Data tab → Import from artifact:** paste the export from the Claude artifact version → your whole July history lands in the database
4. iPhone: Share button → **Add to Home Screen** → Tracker gets an icon and opens full-screen like a native app

## What's new vs the artifact
- **Real persistence.** Every log is a database write, confirmed or honestly failed. The "did it save?" era is over.
- **Global progression.** Leg press is one exercise with one history, no matter which day it appears on. No more manual cross-day math.
- **Any device.** Same ledger on phone, laptop, whatever — it follows your login.
- **Private by design.** Row-level security: your rows are readable only by your login, enforced by the database itself.

## Costs
$0. Supabase and Netlify free tiers cover a personal app (and well beyond) comfortably.

## When something goes wrong
- **"Setup needed" screen** → config.js still has placeholder values
- **"Couldn't load" error** → schema.sql probably didn't run; re-run it in the SQL Editor
- **Sign-up does nothing** → email confirmation is still on (step 2)

## Next chapters (when ready)
- Custom domain (tracker.modernhobbit.com)
- Withings scale sync (needs one Netlify serverless function + Supabase token storage — the architecture is ready for it)
- Rest timer, warm-up sets, per-exercise increments — the v0.3 backlog lives on
- Design system pass
