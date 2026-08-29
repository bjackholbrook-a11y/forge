// Forge — smart food lookup
//
// Two jobs, one endpoint:
//   1. PARSE natural language ("two eggs and a tortilla") into discrete items
//      with quantities.
//   2. RESOLVE each item's nutrition through escalating tiers, and label where
//      the numbers came from:
//        verified  — USDA structured data (default, always tried first)
//        published — the brand's own published nutrition, found via web search
//        estimated — Claude's general-knowledge estimate (soft data)
//
// Escalation past USDA is OPT-IN: the caller passes ?allow=published,estimated.
// That keeps the expensive/slower path off the default flow and makes the user
// consciously choose softer data.
//
// POST /api/food-smart   { text, allow: ['published','estimated'] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const NUTRIENT_KEYS = ['calories','protein','carbs','fat','fiber',
                       'sodium','added_sugar','sat_fat','cholesterol','potassium'];

const NUTRIENT_MAP = {
  '208':'calories','203':'protein','205':'carbs','204':'fat','291':'fiber',
  '307':'sodium','539':'added_sugar','606':'sat_fat','601':'cholesterol','306':'potassium',
};

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

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const usdaKey = process.env.USDA_API_KEY;
  if (!anthropicKey) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON body' }) }; }

  const text = String(body.text || '').trim();
  const allow = Array.isArray(body.allow) ? body.allow : [];
  const allowPublished = allow.includes('published');
  const allowEstimated = allow.includes('estimated');

  if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing text' }) };

  try {
    // ---- 1. PARSE the free text into items ----
    const items = await parseItems(text, anthropicKey);
    if (!items.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ items: [], note: 'Nothing recognised as food.' }) };
    }

    // ---- 2. RESOLVE each item through the tiers ----
    const resolved = [];
    for (const it of items) {
      let r = null;

      // Tier 1 — structured databases (free, fast, trustworthy). USDA first
      // for whole foods; Open Food Facts fills the packaged-goods gap.
      if (usdaKey) r = await usdaLookup(it, usdaKey);
      if (!r) r = await offLookup(it);

      // Tier 2 — brand's published data via Claude web search (opt-in)
      if (!r && allowPublished) r = await webLookup(it, anthropicKey);

      // Tier 3 — Claude estimate (opt-in)
      if (!r && allowEstimated) r = await estimateLookup(it, anthropicKey);

      resolved.push(r || {
        name: it.name, qty: it.qty, serving: it.serving || null,
        found: false, confidence: null, source_url: null, nutrients: null,
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ items: resolved }) };
  } catch (err) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'Smart lookup failed', detail: String((err && err.message) || err) }) };
  }
};

/* ---------- Claude helpers ---------- */

async function claude(messages, key, tools) {
  const payload = { model: MODEL, max_tokens: 1200, messages };
  if (tools) payload.tools = tools;
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Pull all text blocks out of a response and strip code fences.
function textOf(data) {
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .replace(/```json|```/g, '')
    .trim();
}

function parseJSON(s) {
  try { return JSON.parse(s); } catch {}
  // Be forgiving: grab the outermost array/object if the model added prose.
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* ---------- 1. Parse free text into items ---------- */
async function parseItems(text, key) {
  const prompt = `Break this food description into individual items.

Input: "${text}"

Return ONLY a JSON array. No prose, no markdown. Each element:
{"name": "<specific food name, good for a nutrition database search>",
 "qty": <number of servings, default 1>,
 "serving": "<the portion as stated, e.g. '2 slices', '6 oz', or null>",
 "brand": "<restaurant or brand if named, else null>"}

Rules:
- Split compound descriptions into separate items.
- "two eggs" -> name "egg", qty 2.
- Keep brand/restaurant names in the brand field AND in the name if it matters
  (e.g. name "Jet's Pizza pepperoni slice", brand "Jet's Pizza").
- If the input names no food at all, return [].`;

  const data = await claude([{ role: 'user', content: prompt }], key);
  const arr = parseJSON(textOf(data));
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 12).map((x) => ({
    name: String(x.name || '').trim(),
    qty: Number(x.qty) > 0 ? Number(x.qty) : 1,
    serving: x.serving ? String(x.serving) : null,
    brand: x.brand ? String(x.brand) : null,
  })).filter((x) => x.name);
}


/* ---------- relevance guard ----------
   Structured DBs happily return loose matches ("Jet's Pizza pepperoni slice"
   -> "Gummi Jets"). A tier-1 hit only counts if the candidate actually shares
   enough of the query's meaningful words — otherwise we return null so the
   escalation tiers get their turn. */
const REL_STOP = new Set(['a','an','the','of','with','and','or','in','on','slice','slices',
                          'piece','pieces','serving','servings','order','side']);
function relTokens(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !REL_STOP.has(w));
}
// "egg" should match "eggs" but NOT "eggplant". Only allow a length difference
// of 2 or less, which covers plurals and simple inflections.
function looseEq(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  return a.startsWith(b) || b.startsWith(a);
}
function isRelevant(item, candidateName) {
  const want = [...new Set(relTokens(`${item.brand || ''} ${item.name}`))];
  if (!want.length) return true;
  const got = relTokens(candidateName);
  const gotSet = new Set(got);
  const present = (w) => gotSet.has(w) || got.some((g) => looseEq(w, g));
  const hits = want.filter(present);
  if (hits.length / want.length < 0.6) return false;

  // If a brand was named, EVERY word of the brand must appear. Requiring only
  // "some" lets a generic word carry the match: "Jet's Pizza" -> [jet, pizza],
  // and "Pizza Hut Pepperoni Pizza" satisfies "pizza" while missing "jet".
  if (item.brand) {
    const brandWords = [...new Set(relTokens(item.brand))];
    if (brandWords.length && !brandWords.every(present)) return false;
  }
  return true;
}

/* ---------- Tier 1: USDA ---------- */
async function usdaLookup(item, usdaKey) {
  const q = item.brand ? `${item.brand} ${item.name}` : item.name;
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + `?api_key=${encodeURIComponent(usdaKey)}`
    + `&query=${encodeURIComponent(q)}`
    + '&pageSize=5&dataType=Foundation,SR%20Legacy,Branded';
  let data;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    data = await r.json();
  } catch { return null; }

  const f = (data.foods || []).find((x) => x && x.description && isRelevant(item, x.description));
  if (!f) return null;

  const nutrients = blank();
  (f.foodNutrients || []).forEach((n) => {
    const k = NUTRIENT_MAP[String(n.nutrientNumber)];
    if (k) nutrients[k] = round(n.value || 0);
  });
  if (!nutrients.calories && !nutrients.protein && !nutrients.carbs && !nutrients.fat) return null;

  return {
    name: titleCase(f.description),
    qty: item.qty,
    serving: f.householdServingFullText || (f.servingSize ? `${f.servingSize}${f.servingSizeUnit || ''}` : '100 g'),
    per: f.servingSize ? 'serving' : '100g',
    found: true,
    confidence: 'verified',
    source_url: null,
    source_label: 'USDA FoodData Central',
    nutrients,
  };
}


/* ---------- Tier 1b: Open Food Facts (free, no key, strong on packaged goods) ---------- */
async function offLookup(item) {
  const q = item.brand ? `${item.brand} ${item.name}` : item.name;
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(q)}`
    + '&search_simple=1&action=process&json=1&page_size=5'
    + '&fields=product_name,brands,serving_size,nutriments,url';
  let data;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Forge/1.0 (Modern Hobbit)' } });
    if (!r.ok) return null;
    data = await r.json();
  } catch { return null; }

  const p = (data.products || []).find((x) => {
    if (!x || !x.nutriments || !x.product_name) return false;
    const brand = (x.brands || '').split(',')[0].trim();
    return isRelevant(item, `${brand} ${x.product_name}`);
  });
  if (!p) return null;
  const nm = p.nutriments || {};

  // OFF reports per 100g by default; prefer per-serving when present.
  const useServing = nm['energy-kcal_serving'] != null || nm.proteins_serving != null;
  const pick = (base) => {
    const v = useServing ? nm[`${base}_serving`] : nm[`${base}_100g`];
    return round(v || 0);
  };
  const nutrients = blank();
  nutrients.calories     = round((useServing ? nm['energy-kcal_serving'] : nm['energy-kcal_100g']) || 0);
  nutrients.protein      = pick('proteins');
  nutrients.carbs        = pick('carbohydrates');
  nutrients.fat          = pick('fat');
  nutrients.fiber        = pick('fiber');
  nutrients.sat_fat      = pick('saturated-fat');
  nutrients.added_sugar  = pick('sugars');
  // OFF gives sodium/potassium in GRAMS — Forge stores mg.
  nutrients.sodium       = round((useServing ? (nm.sodium_serving || 0) : (nm.sodium_100g || 0)) * 1000);
  nutrients.potassium    = round((useServing ? (nm.potassium_serving || 0) : (nm.potassium_100g || 0)) * 1000);
  nutrients.cholesterol  = round((useServing ? (nm.cholesterol_serving || 0) : (nm.cholesterol_100g || 0)) * 1000);

  if (!nutrients.calories && !nutrients.protein && !nutrients.carbs && !nutrients.fat) return null;

  const brand = (p.brands || '').split(',')[0].trim();
  return {
    name: titleCase(brand ? `${brand} ${p.product_name}` : p.product_name),
    qty: item.qty,
    serving: useServing ? (p.serving_size || '1 serving') : '100 g',
    per: useServing ? 'serving' : '100g',
    found: true,
    confidence: 'verified',
    source_url: p.url || null,
    source_label: 'Open Food Facts',
    nutrients,
  };
}

/* ---------- Tier 2: brand's published data, via web search ---------- */
async function webLookup(item, key) {
  const label = item.brand ? `${item.brand} ${item.name}` : item.name;
  const prompt = `Find the OFFICIAL published nutrition information for: ${label}${item.serving ? ` (serving: ${item.serving})` : ''}

Search the web, preferring the company's own nutrition page or PDF.

Return ONLY JSON, no prose:
{"found": true|false,
 "name": "<item name>",
 "serving": "<the serving the numbers describe>",
 "source_url": "<the exact page you took the numbers from>",
 "nutrients": {"calories":n,"protein":n,"carbs":n,"fat":n,"fiber":n,
               "sodium":n,"added_sugar":n,"sat_fat":n,"cholesterol":n,"potassium":n}}

Rules:
- Only set found=true if you actually located published figures for THIS item.
- Do NOT guess here. If you can't find published data, return {"found": false}.
- Grams for macros, milligrams for sodium/cholesterol/potassium, kcal for calories.
- Use 0 for anything genuinely absent; omit nothing.`;

  let data;
  try {
    data = await claude([{ role: 'user', content: prompt }], key,
      [{ type: 'web_search_20250305', name: 'web_search' }]);
  } catch { return null; }

  const j = parseJSON(textOf(data));
  if (!j || !j.found || !j.nutrients) return null;

  const nutrients = blank();
  NUTRIENT_KEYS.forEach((k) => { nutrients[k] = round(j.nutrients[k] || 0); });
  if (!nutrients.calories && !nutrients.protein && !nutrients.carbs && !nutrients.fat) return null;

  const url = typeof j.source_url === 'string' && /^https?:\/\//i.test(j.source_url) ? j.source_url : null;

  return {
    name: j.name || label,
    qty: item.qty,
    serving: j.serving || item.serving || '1 serving',
    per: 'serving',
    found: true,
    confidence: 'published',
    source_url: url,
    source_label: url ? hostOf(url) : 'Published by the brand',
    nutrients,
  };
}

/* ---------- Tier 3: estimate ---------- */
async function estimateLookup(item, key) {
  const label = item.brand ? `${item.brand} ${item.name}` : item.name;
  const prompt = `Estimate the nutrition for: ${label}${item.serving ? ` (serving: ${item.serving})` : ''}

This is a best-effort estimate from general knowledge — no published data was found.

Return ONLY JSON, no prose:
{"name":"<item>","serving":"<assumed serving>",
 "nutrients":{"calories":n,"protein":n,"carbs":n,"fat":n,"fiber":n,
              "sodium":n,"added_sugar":n,"sat_fat":n,"cholesterol":n,"potassium":n}}

Grams for macros, mg for sodium/cholesterol/potassium, kcal for calories.
Be realistic about typical restaurant/retail portion sizes.`;

  let data;
  try { data = await claude([{ role: 'user', content: prompt }], key); }
  catch { return null; }

  const j = parseJSON(textOf(data));
  if (!j || !j.nutrients) return null;

  const nutrients = blank();
  NUTRIENT_KEYS.forEach((k) => { nutrients[k] = round(j.nutrients[k] || 0); });
  if (!nutrients.calories && !nutrients.protein && !nutrients.carbs && !nutrients.fat) return null;

  return {
    name: j.name || label,
    qty: item.qty,
    serving: j.serving || item.serving || '1 serving',
    per: 'serving',
    found: true,
    confidence: 'estimated',
    source_url: null,
    source_label: 'Estimated from general sources',
    nutrients,
  };
}

/* ---------- small helpers ---------- */
function blank() {
  const o = {}; NUTRIENT_KEYS.forEach((k) => { o[k] = 0; }); return o;
}
function round(v) { return Math.round((Number(v) || 0) * 10) / 10; }
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'source'; }
}
