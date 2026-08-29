// Forge — USDA FoodData Central search function
// Holds the USDA API key secretly (env var), searches USDA, maps results to
// Forge's 10 nutrients, then RE-RANKS them by how well they actually match the
// query and groups whole foods above branded products.
//
// Browser calls:  /api/food-search?q=chicken breast bone in
// (netlify.toml rewrites that to /.netlify/functions/food-search)

const NUTRIENT_MAP = {
  '208': 'calories',      // Energy (kcal)
  '203': 'protein',
  '205': 'carbs',
  '204': 'fat',
  '291': 'fiber',
  '307': 'sodium',
  '539': 'added_sugar',
  '606': 'sat_fat',
  '601': 'cholesterol',
  '306': 'potassium',
};

// Words that add no signal when matching a food name.
const STOP = new Set(['a','an','the','of','with','and','or','in','on']);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const key = process.env.USDA_API_KEY;
  if (!key) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'USDA_API_KEY not set in Netlify environment.' }) };
  }

  const q = ((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (!q) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing search query (?q=).' }) };
  }

  try {
    // Pull a wider net (50) so our own ranking has good material to work with,
    // then trim to the best 25 after scoring.
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
      + `?api_key=${encodeURIComponent(key)}`
      + `&query=${encodeURIComponent(q)}`
      + '&pageSize=50'
      + '&dataType=Foundation,SR%20Legacy,Branded';

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return { statusCode: resp.status, headers,
        body: JSON.stringify({ error: `USDA API error (${resp.status})`, detail: text.slice(0, 300) }) };
    }
    const data = await resp.json();

    const terms = tokenize(q);

    let foods = (data.foods || []).map((f) => {
      const nutrients = {
        calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0,
        sodium: 0, added_sugar: 0, sat_fat: 0, cholesterol: 0, potassium: 0,
      };
      (f.foodNutrients || []).forEach((n) => {
        const k = NUTRIENT_MAP[String(n.nutrientNumber)];
        if (k) nutrients[k] = round(n.value || 0);
      });

      const name = cleanName(f.description);
      return {
        fdcId: f.fdcId,
        name,
        brand: f.brandOwner || f.brandName || null,
        dataType: f.dataType,
        servingSize: f.servingSize || null,
        servingUnit: f.servingSizeUnit || null,
        householdServing: f.householdServingFullText || null,
        per: f.servingSize ? 'serving' : '100g',
        nutrients,
        _score: scoreMatch(name, f.dataType, terms),
      };
    })
    .filter((f) => f.nutrients.calories || f.nutrients.protein || f.nutrients.carbs || f.nutrients.fat);

    // Sort by our relevance score (high to low).
    foods.sort((a, b) => b._score - a._score);
    foods = foods.slice(0, 25);

    // Group: whole foods first, branded second. Each group stays score-sorted.
    const whole   = foods.filter((f) => f.dataType !== 'Branded');
    const branded = foods.filter((f) => f.dataType === 'Branded');
    foods.forEach((f) => { delete f._score; });

    return { statusCode: 200, headers, body: JSON.stringify({
      query: q,
      count: foods.length,
      groups: [
        { label: 'Whole foods', items: whole },
        { label: 'Branded products', items: branded },
      ].filter((g) => g.items.length),
      foods, // flat list kept for backward compatibility
    }) };
  } catch (err) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'Search failed', detail: String((err && err.message) || err) }) };
  }
};

function tokenize(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !STOP.has(w));
}

// Score how well a USDA description matches the user's query. Higher is better.
// Goal: "chicken breast bone in" ranks an entry containing all those words far
// above a generic "chicken, tenders".
function scoreMatch(name, dataType, terms) {
  const lower = String(name).toLowerCase();
  const words = tokenize(name);
  const wordSet = new Set(words);
  let score = 0;

  // 1. Every query term present is the strongest signal.
  let hits = 0;
  terms.forEach((t) => {
    if (wordSet.has(t)) { hits += 1; score += 12; }
    else if (lower.includes(t)) { hits += 1; score += 7; }   // substring (plurals etc.)
  });
  if (terms.length && hits === terms.length) score += 30;    // ALL terms matched

  // 2. Exact phrase appearing intact.
  if (terms.length > 1 && lower.includes(terms.join(' '))) score += 25;

  // 3. Matches near the START of the name matter more ("Chicken, breast..."
  //    beats "Soup, cream of chicken").
  if (terms.length && words.length) {
    const firstIdx = words.indexOf(terms[0]);
    if (firstIdx === 0) score += 12;
    else if (firstIdx > 0 && firstIdx < 3) score += 6;
  }

  // 4. Shorter, simpler names are usually the cleaner canonical entry.
  score -= Math.min(12, Math.floor(words.length / 3));

  // 5. Prefer curated datasets over the messy branded pile.
  if (dataType === 'Foundation') score += 10;
  else if (dataType === 'SR Legacy') score += 8;
  else if (dataType === 'Survey (FNDDS)') score += 4;

  return score;
}

function round(v) { return Math.round((Number(v) || 0) * 10) / 10; }

function cleanName(s) {
  if (!s) return 'Unknown food';
  return String(s).toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}
