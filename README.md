# Forge

Diet & fitness tracker by Modern Hobbit. Static front-end (`index.html`) on Netlify,
Supabase for auth + database, Netlify Functions for anything needing a secret API key.

## Structure

```
index.html              The whole app (front-end)
config.js               Supabase URL + anon key (safe to be public)
netlify.toml            Netlify config: publish dir + functions dir + /api/* redirect
package.json            Node project metadata
netlify/functions/      Serverless functions (hold secret keys)
  food-search.js        USDA FoodData Central search
supabase/               SQL schema files (run in Supabase SQL editor)
```

## Deploy

Connected to Netlify via GitHub. **Every push to `main` auto-deploys.**
No more drag-and-drop. Edit → commit → push → live in ~1 minute.

## Environment variables (set in Netlify dashboard → Site settings → Environment variables)

- `USDA_API_KEY` — USDA FoodData Central key (secret; never commit it)

Future: `ANTHROPIC_API_KEY` (natural-language food parsing), Withings creds.

## Functions

Called from the app at `/api/<name>` (redirected to `/.netlify/functions/<name>`).

- `GET /api/food-search?q=chicken breast` → `{ foods: [...] }`
