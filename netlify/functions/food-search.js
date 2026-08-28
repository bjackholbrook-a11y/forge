// Forge — USDA FoodData Central search function
// Runs on Netlify's servers. Holds the USDA API key secretly (from an env var),
// searches USDA, and returns clean results mapped to Forge's 10 nutrients.
//
// The browser calls:  /api/food-search?q=chicken breast
// (which Netlify rewrites to /.netlify/functions/food-search per netlify.toml)

// USDA nutrient numbers → Forge's nutrient keys.
// These "nutrientNumber" values are USDA's stable identifiers.
const NUTRIENT_MAP = {
  '208': 'calories',      // Energy (kcal)
  '203': 'protein',       // Protein
  '205': 'carbs',         // Carbohydrate, by difference
  '204': 'fat',           // Total lipid (fat)
  '291': 'fiber',         // Fiber, total dietary
  '307': 'sodium',        // Sodium, Na
  '539': 'added_sugar',   // Sugars, added
  '606': 'sat_fat',       // Fatty acids, total saturated
  '601': 'cholesterol',   // Cholesterol
  '306': 'potassium',     // Potassium, K
};

exports.handler = async (event) => {
  // CORS + method guard
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const key = process.env.USDA_API_KEY;
  if (!key) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'USDA_API_KEY not set in Netlify environment.' }) };
  }

  const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (!q) {
    return { statusCode: 400, headers,
      body: JSON.stringify({ error: 'Missing search query (?q=).' }) };
  }

  try {
    // USDA search. dataType filter favors real foods over branded noise;
    // we include Foundation, SR Legacy, and Survey (typical whole foods) plus Branded.
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
      + `?api_key=${encodeURIComponent(key)}`
      + `&query=${encodeURIComponent(q)}`
      + '&pageSize=25'
      + '&dataType=Foundation,SR%20Legacy,Branded';

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return { statusCode: resp.status, headers,
        body: JSON.stringify({ error: `USDA API error (${resp.status})`, detail: text.slice(0, 300) }) };
    }
    const data = await resp.json();

    const foods = (data.foods || []).map((f) => {
      // Build a nutrients object in Forge's shape (per 100g or per serving as USDA gives).
      const nutrients = {
        calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0,
        sodium: 0, added_sugar: 0, sat_fat: 0, cholesterol: 0, potassium: 0,
      };
      (f.foodNutrients || []).forEach((n) => {
        const key = NUTRIENT_MAP[String(n.nutrientNumber)];
        if (key) nutrients[key] = round(n.value || 0);
      });

      // USDA search results are per 100g for Foundation/SR, or per serving for Branded.
      // We surface the serving info so the app can scale.
      return {
        fdcId: f.fdcId,
        name: cleanName(f.description),
        brand: f.brandOwner || f.brandName || null,
        dataType: f.dataType,
        // Branded foods carry a serving size; whole foods are per 100g.
        servingSize: f.servingSize || null,
        servingUnit: f.servingSizeUnit || null,
        householdServing: f.householdServingFullText || null,
        per: f.servingSize ? 'serving' : '100g',
        nutrients,
      };
    })
    // Drop results with no calorie/macro data at all (USDA has some empty entries).
    .filter((f) => f.nutrients.calories || f.nutrients.protein || f.nutrients.carbs || f.nutrients.fat);

    return { statusCode: 200, headers, body: JSON.stringify({ query: q, count: foods.length, foods }) };
  } catch (err) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'Search failed', detail: String(err && err.message || err) }) };
  }
};

function round(v) { return Math.round((Number(v) || 0) * 10) / 10; }

// USDA descriptions are ALL CAPS and comma-heavy for branded items.
// Tidy them to title-case-ish, keeping it readable.
function cleanName(s) {
  if (!s) return 'Unknown food';
  const lower = s.toLowerCase();
  // capitalize first letter of each word, but keep it simple
  return lower.replace(/\b\w/g, (c) => c.toUpperCase());
}
