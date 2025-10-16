// services/geoClient.js
const fetch = require('node-fetch');

const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const KEY = process.env.GOOGLE_MAPS_API_KEY;

// 從原始輸入中盡量抓樓層（中文/數字）
function extractFloor(input = '') {
  const m = String(input).match(/([0-9０-９一二三四五六七八九十]+)\s*樓/);
  return m ? m[1].replace(/[０-９]/g, d => String('０１２３４５６７８９'.indexOf(d))) : '';
}

// 從 geocoding address_components 推出市+區
function cityDistrictFromComponents(components = []) {
  const pick = t => (components.find(c => c.types.includes(t)) || {}).long_name || '';
  // 台灣常見：level_1=直轄市/縣、level_2=區/鄉鎮、市
  const city = pick('administrative_area_level_1') || pick('administrative_area_level_2');
  const dist = pick('administrative_area_level_2') || pick('administrative_area_level_3');
  if (city && dist && city !== dist) return city + dist;
  return city || dist || '';
}

// 優先從 geocoding components 推「社區/大樓」名稱；不夠再用 Places Text Search
function pickCommunityFromComponents(components = []) {
  const pref = ['premise', 'subpremise', 'establishment', 'point_of_interest',
                'neighborhood', 'sublocality_level_1', 'sublocality'];
  for (const t of pref) {
    const c = components.find(x => x.types.includes(t));
    if (c && c.long_name) return c.long_name;
  }
  return '';
}

async function geocode(address) {
  const url = `${MAPS_BASE}/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Geocode HTTP ${r.status}`);
  return r.json();
}

async function placesTextSearch(query) {
  const url = `${MAPS_BASE}/place/textsearch/json?query=${encodeURIComponent(query)}&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TextSearch HTTP ${r.status}`);
  return r.json();
}

async function placeDetails(placeId) {
  const fields = ['name','formatted_address','address_components','geometry','types'].join(',');
  const url = `${MAPS_BASE}/place/details/json?place_id=${placeId}&fields=${fields}&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Details HTTP ${r.status}`);
  return r.json();
}

/**
 * geocodeAddress(raw): 回傳
 * {
 *   ok: true/false,
 *   data: {
 *     fullCityDistrict,         // 例：新北市板橋區
 *     formattedAddress,         // Google 標準地址
 *     floor,                    // 從原始輸入推得的「幾樓」(可空)
 *     community,                // 社區/大樓（盡量推）
 *     sublocality,              // 次行政區（備用）
 *     placeId,                  // 主要 Place ID
 *     location: { lat, lng }
 *   }
 * }
 */
async function geocodeAddress(raw = '') {
  if (!KEY) return { ok: false, error: 'Missing GOOGLE_MAPS_API_KEY' };
  const floor = extractFloor(raw);

  // Step 1: geocode
  const g = await geocode(raw);
  const best = (g.results || [])[0];
  if (!best) return { ok: false, error: 'GEOCODE_ZERO_RESULTS' };

  const comps = best.address_components || [];
  const formattedAddress = best.formatted_address || '';
  const location = best.geometry?.location || {};
  const placeId = best.place_id || '';
  const fullCityDistrict = cityDistrictFromComponents(comps);

  let community = pickCommunityFromComponents(comps);
  const sublocality =
    (comps.find(c => c.types.includes('sublocality_level_1')) || {}).long_name ||
    (comps.find(c => c.types.includes('sublocality')) || {}).long_name || '';

  // Step 2: 不夠明確再用 Places Text Search 強化，盡量抓到社區/大樓名稱
  if (!community) {
    try {
      const t = await placesTextSearch(raw);
      const first = (t.results || [])[0];
      if (first && first.place_id) {
        const d = await placeDetails(first.place_id);
        const p = d.result || {};
        const route = (p.address_components || []).find(c => c.types.includes('route'))?.long_name || '';
        // 避免把路名當作社區名
        if (p.name && p.name.replace(/\s/g,'') !== route.replace(/\s/g,'')) {
          community = p.name;
        }
      }
    } catch (e) {
      // 靜默失敗，不中斷
    }
  }

  return {
    ok: true,
    data: {
      fullCityDistrict,
      formattedAddress,
      floor,
      community,
      sublocality,
      placeId,
      location
    }
  };
}

module.exports = { geocodeAddress };
