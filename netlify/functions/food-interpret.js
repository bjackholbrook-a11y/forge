// Forge — query interpretation. Runs BEFORE any database search.
//
// Claude reads what the user actually meant and says where to look. This
// matters because keyword matching can't tell that "Jet's Pizza pepperoni
// slice" is a regional restaurant item that no nutrition database carries —
// it just matches the word "pizza" and returns Domino's.
//
//   POST /api/food-interpret   { q }
//
// Response: { items: [ { name, brand, qty, serving, kind, dbQuery } ] }
//   kind 'restaurant' -> skip the databases, go straight to the brand's site
//   kind 'packaged'   -> databases first (Open Food Facts is good here)
//   kind 'whole'      -> databases first (USDA is good here)
//
// Deliberately small and fast: no web search tool, low token ceiling.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const q = String(body.q || '').trim();
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing q' }) };

  // No key? Degrade gracefully to a plain database query rather than failing.
  if (!key) {
    return { statusCode: 200, headers, body: JSON.stringify({ items: [fallback(q)], degraded: true }) };
  }

  const prompt = `A user typed this into a food-logging search box: "${q}"

Work out what they actually mean, then say where the nutrition data is likely to live.

Reply with ONLY a JSON array, no prose. One element per distinct food:
[{"name":"<clear food name>",
  "brand":"<restaurant or manufacturer, else null>",
  "qty":<number of servings, default 1>,
  "serving":"<portion as stated, e.g. '2 slices', '6 oz', else null>",
  "kind":"restaurant"|"packaged"|"whole",
  "dbQuery":"<best short phrase for searching a nutrition database>"}]

How to choose "kind":
- "restaurant" — an item from a restaurant/chain menu (Jet's Pizza, Chipotle,
  a local diner). Nutrition databases do NOT carry these; we'll check the
  brand's own website instead.
- "packaged" — a branded grocery product with a label (Tyson strips, Chobani).
- "whole" — a generic/unbranded food (chicken breast, brown rice, an apple).

Rules:
- Split "two eggs and a tortilla" into two elements.
- "two eggs" -> name "egg", qty 2.
- Keep the brand in BOTH "brand" and "name" when it identifies the item.
- dbQuery should drop brand names for restaurant items (they won't help) and
  keep them for packaged goods (they will).
- If nothing in the text is food, return [].`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) {
      const t = await r.text();
      // Still usable without interpretation — fall back rather than break search.
      return { statusCode: 200, headers,
        body: JSON.stringify({ items: [fallback(q)], degraded: true, detail: t.slice(0, 160) }) };
    }
    const data = await r.json();
    const txt = (data.content || []).filter((b) => b.type === 'text')
      .map((b) => b.text).join('\n').replace(/```json|```/g, '').trim();

    let arr = null;
    try { arr = JSON.parse(txt); }
    catch {
      const m = txt.match(/\[[\s\S]*\]/);
      if (m) { try { arr = JSON.parse(m[0]); } catch {} }
    }
    if (!Array.isArray(arr) || !arr.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ items: [fallback(q)], degraded: true }) };
    }

    const items = arr.slice(0, 8).map((x) => ({
      name: String(x.name || '').trim() || q,
      brand: x.brand ? String(x.brand).trim() : null,
      qty: Number(x.qty) > 0 ? Number(x.qty) : 1,
      serving: x.serving ? String(x.serving) : null,
      kind: ['restaurant', 'packaged', 'whole'].includes(x.kind) ? x.kind : 'whole',
      dbQuery: String(x.dbQuery || x.name || q).trim(),
    })).filter((x) => x.name);

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch (err) {
    return { statusCode: 200, headers,
      body: JSON.stringify({ items: [fallback(q)], degraded: true, detail: String(err && err.message) }) };
  }
};

function fallback(q) {
  return { name: q, brand: null, qty: 1, serving: null, kind: 'whole', dbQuery: q };
}
