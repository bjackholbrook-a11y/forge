// Forge — food lookup tier 2/3: AI-assisted, ONE item per request.
//
// Deliberately scoped to a single item and a single mode so each call stays
// well inside Netlify's function timeout. The client calls this only when the
// databases came up empty, and calls it once per mode:
//
//   POST /api/food-ai   { name, brand?, serving?, mode: 'web' | 'estimate' }
//
// mode 'web'      -> search for the brand's OFFICIAL published nutrition
// mode 'estimate' -> best-effort estimate from general knowledge
//
// Response: { found, item } where item carries source/sourceLabel/sourceUrl.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const NUTRIENT_KEYS = ['calories','protein','carbs','fat','fiber',
                       'sodium','added_sugar','sat_fat','cholesterol','potassium'];

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
  if (!key) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const name = String(body.name || '').trim();
  const brand = body.brand ? String(body.brand).trim() : '';
  const serving = body.serving ? String(body.serving).trim() : '';
  const mode = body.mode === 'estimate' ? 'estimate' : 'web';
  if (!name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing name' }) };

  const label = brand ? `${brand} ${name}` : name;

  try {
    const out = mode === 'web'
      ? await webLookup(label, serving, key)
      : await estimateLookup(label, serving, key);
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 502, headers,
      body: JSON.stringify({ found: false, error: String((err && err.message) || err) }) };
  }
};

async function webLookup(label, serving, key) {
  const prompt = `Find the OFFICIAL published nutrition information for: ${label}${serving ? ` (serving: ${serving})` : ''}

Search the web, preferring the company's own nutrition page or PDF.

Reply with ONLY JSON, no prose:
{"found":true|false,"name":"...","serving":"<what the numbers describe>",
 "source_url":"<exact page the numbers came from>",
 "nutrients":{"calories":n,"protein":n,"carbs":n,"fat":n,"fiber":n,
              "sodium":n,"added_sugar":n,"sat_fat":n,"cholesterol":n,"potassium":n}}

Rules:
- found=true ONLY if you actually located published figures for this item. Do not guess here.
- Grams for macros, milligrams for sodium/cholesterol/potassium, kcal for calories.
- Use 0 for anything genuinely absent.
- Be concise; do not explain your search.`;

  const data = await claude(prompt, key, [{ type: 'web_search_20250305', name: 'web_search' }]);
  const j = parseJSON(textOf(data));
  if (!j || !j.found || !j.nutrients) return { found: false };

  const n = coerce(j.nutrients);
  if (!hasData(n)) return { found: false };
  const url = typeof j.source_url === 'string' && /^https?:\/\//i.test(j.source_url) ? j.source_url : null;

  return { found: true, item: {
    id: 'web-' + Math.random().toString(36).slice(2),
    name: j.name || label,
    brand: null,
    serving: j.serving || serving || '1 serving',
    per: 'serving',
    nutrients: n,
    source: 'web',
    sourceLabel: url ? hostOf(url) : 'Brand website',
    sourceUrl: url,
  } };
}

async function estimateLookup(label, serving, key) {
  const prompt = `Estimate the nutrition for: ${label}${serving ? ` (serving: ${serving})` : ''}

No published data was found, so this is a best-effort estimate from general knowledge.
Be realistic about typical restaurant/retail portion sizes.

Reply with ONLY JSON, no prose:
{"name":"...","serving":"<assumed serving>",
 "nutrients":{"calories":n,"protein":n,"carbs":n,"fat":n,"fiber":n,
              "sodium":n,"added_sugar":n,"sat_fat":n,"cholesterol":n,"potassium":n}}

Grams for macros, mg for sodium/cholesterol/potassium, kcal for calories.`;

  const data = await claude(prompt, key);
  const j = parseJSON(textOf(data));
  if (!j || !j.nutrients) return { found: false };
  const n = coerce(j.nutrients);
  if (!hasData(n)) return { found: false };

  return { found: true, item: {
    id: 'est-' + Math.random().toString(36).slice(2),
    name: j.name || label,
    brand: null,
    serving: j.serving || serving || '1 serving',
    per: 'serving',
    nutrients: n,
    source: 'estimate',
    sourceLabel: 'Estimate',
    sourceUrl: null,
  } };
}

/* ---------- helpers ---------- */
async function claude(prompt, key, tools) {
  const payload = { model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] };
  if (tools) payload.tools = tools;
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}
function textOf(data) {
  return (data.content || []).filter((b) => b.type === 'text')
    .map((b) => b.text).join('\n').replace(/```json|```/g, '').trim();
}
function parseJSON(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function coerce(raw) {
  const n = {};
  NUTRIENT_KEYS.forEach((k) => { n[k] = Math.round((Number(raw[k]) || 0) * 10) / 10; });
  return n;
}
function hasData(n) { return !!(n.calories || n.protein || n.carbs || n.fat); }
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'source'; }
}
