// Forge — food search, tier 1: structured databases (fast, free, no AI).
//
// Returns ONE FLAT LIST with a source label on every row. No categories.
// Called first, always. Typically returns in well under a second.
//
//   GET /api/food-db?q=chicken breast&page=1
//
// Response: { query, page, hasMore, items: [ {..., source, sourceLabel} ] }

const NUTRIENT_MAP = {
  '208':'calories','203':'protein','205':'carbs','204':'fat','291':'fiber',
  '307':'sodium','539':'added_sugar','606':'sat_fat','601':'cholesterol','306':'potassium',
};
const NUTRIENT_KEYS = Object.values(NUTRIENT_MAP);
const STOP = new Set(['a','an','the','of','with','and','or','in','on']);
const SYNONYMS = { bone:['skin'], bonein:['skin'], boneless:['meat'], skinless:['meat'] };

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const qs = event.queryStringParameters || {};
  const q = (qs.q || '').trim();
  const page = Math.max(1, parseInt(qs.page || '1', 10) || 1);
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query' }) };

  const terms = tokenize(q);

  // Both sources in parallel — neither blocks the other.
  const [usda, off] = await Promise.all([
    usdaSearch(q, page, process.env.USDA_API_KEY).catch(() => ({ items: [], hasMore: false })),
    page === 1 ? offSearch(q).catch(() => []) : Promise.resolve([]),
  ]);

  const all = usda.items.concat(off)
    .map((f) => ({ ...f, _score: scoreMatch(f.name, f.source, terms) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 30);
  all.forEach((f) => { delete f._score; });

  return { statusCode: 200, headers, body: JSON.stringify({
    query: q, page, hasMore: usda.hasMore, items: all,
  }) };
};

/* ---------- USDA ---------- */
async function usdaSearch(q, page, key) {
  if (!key) return { items: [], hasMore: false };
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + `?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}`
    + `&pageSize=50&pageNumber=${page}&dataType=Foundation,SR%20Legacy,Branded`;
  const r = await fetch(url);
  if (!r.ok) return { items: [], hasMore: false };
  const data = await r.json();

  const items = (data.foods || []).map((f) => {
    const n = blank();
    (f.foodNutrients || []).forEach((x) => {
      const k = NUTRIENT_MAP[String(x.nutrientNumber)];
      if (k) n[k] = round(x.value || 0);
    });
    if (!hasData(n)) return null;
    return {
      id: 'usda-' + f.fdcId,
      name: titleCase(f.description),
      brand: f.brandOwner || f.brandName || null,
      serving: f.householdServingFullText
        || (f.servingSize ? `${f.servingSize}${f.servingSizeUnit || ''}` : '100 g'),
      per: f.servingSize ? 'serving' : '100g',
      nutrients: n,
      // Foundation/SR Legacy are lab-analysed; Branded is label data.
      source: f.dataType === 'Branded' ? 'usda_branded' : 'usda',
      sourceLabel: f.dataType === 'Branded' ? 'USDA (label)' : 'USDA verified',
      sourceUrl: null,
    };
  }).filter(Boolean);

  return { items, hasMore: Number(data.totalHits || 0) > page * 50 };
}

/* ---------- Open Food Facts ---------- */
async function offSearch(q) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1`
    + '&page_size=15&fields=code,product_name,brands,serving_size,nutriments,url';
  const r = await fetch(url, { headers: { 'User-Agent': 'Forge/1.0 (Modern Hobbit)' } });
  if (!r.ok) return [];
  const data = await r.json();

  return (data.products || []).map((p) => {
    if (!p.product_name || !p.nutriments) return null;
    const nm = p.nutriments;
    const perServing = nm['energy-kcal_serving'] != null;
    const pick = (b) => round((perServing ? nm[`${b}_serving`] : nm[`${b}_100g`]) || 0);
    const mg = (b) => round(((perServing ? nm[`${b}_serving`] : nm[`${b}_100g`]) || 0) * 1000);
    const n = {
      calories: round((perServing ? nm['energy-kcal_serving'] : nm['energy-kcal_100g']) || 0),
      protein: pick('proteins'), carbs: pick('carbohydrates'), fat: pick('fat'),
      fiber: pick('fiber'), sat_fat: pick('saturated-fat'), added_sugar: pick('sugars'),
      sodium: mg('sodium'), potassium: mg('potassium'), cholesterol: mg('cholesterol'),
    };
    if (!hasData(n)) return null;
    const brand = (p.brands || '').split(',')[0].trim();
    return {
      id: 'off-' + (p.code || Math.random().toString(36).slice(2)),
      name: titleCase(brand ? `${brand} ${p.product_name}` : p.product_name),
      brand: brand || null,
      serving: perServing ? (p.serving_size || '1 serving') : '100 g',
      per: perServing ? 'serving' : '100g',
      nutrients: n,
      source: 'off',
      sourceLabel: 'Open Food Facts',
      sourceUrl: p.url || null,
    };
  }).filter(Boolean);
}

/* ---------- ranking ---------- */
function tokenize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/).filter((w) => w && !STOP.has(w));
}
function scoreMatch(name, source, terms) {
  const lower = String(name).toLowerCase();
  const words = tokenize(name);
  const set = new Set(words);
  let score = 0, hits = 0;
  terms.forEach((t) => {
    if (set.has(t)) { hits++; score += 12; }
    else if (lower.includes(t)) { hits++; score += 7; }
    else {
      const alts = SYNONYMS[t];
      if (alts && alts.some((a) => set.has(a))) { hits++; score += 5; }
    }
  });
  if (terms.length && hits === terms.length) score += 30;
  if (terms.length > 1 && lower.includes(terms.join(' '))) score += 25;
  if (terms.length && words.length) {
    const i = words.indexOf(terms[0]);
    if (i === 0) score += 12; else if (i > 0 && i < 3) score += 6;
  }
  score -= Math.min(12, Math.floor(words.length / 3));
  if (source === 'usda') score += 10;          // lab-analysed whole foods
  else if (source === 'off') score += 2;
  return score;
}

/* ---------- helpers ---------- */
function blank() { const o = {}; NUTRIENT_KEYS.forEach((k) => { o[k] = 0; }); return o; }
function hasData(n) { return !!(n.calories || n.protein || n.carbs || n.fat); }
function round(v) { return Math.round((Number(v) || 0) * 10) / 10; }
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
