// services/geoClient.js
const fetch = require('node-fetch');

const MAPS_BASE = 'https://maps.googleapis.com/maps/api';
const KEY = process.env.GOOGLE_MAPS_API_KEY;

// 將全形數字轉半形
function toHalfWidthDigits(s = '') {
  const fw = '０１２３４５６７８９';
  return String(s).replace(/[０-９]/g, ch => String(fw.indexOf(ch)));
}

// 從原始輸入盡量抓樓層（支援中文/全形/半形數字）
function extractFloor(input = '') {
  const m = String(input).match(/([0-9０-９一二三四五六七八九十]+)\s*樓/);
  if (!m) return '';
  const num = toHalfWidthDigits(m[1]);
  return num; // 保留原樣（e.g. 4 / 四）
}

// 從 geocoding address_components 推出「市+區」
function cityDistrictFromComponents(components = []) {
  const pick = t => (components.find(c => (c.types || []).includes(t)) || {}).long_name || '';
  const city =
    pick('administrative_area_level_1') || // 台北市、新北市
    pick('administrative_area_level_2');   // 有些地區可能塞在 level_2
  const dist =
    pick('administrative_area_level_2') ||
    pick('administrative_area_level_3');
  if (city && dist && city !== dist) return city + dist;
  return city || dist || '';
}

// 從 components 優先挑一個「社區/大樓」名稱
function pickCommunityFromComponents(components = []) {
  const pref = [
    'premise',               // 建築物、社區
    'subpremise',            // 棟/梯/樓層名
    'establishment',         // 設施/機構
    'point_of_interest',     // 興趣點
    'neighborhood',          // 鄰里
    'sublocality_level_1',
    'sublocality',
  ];
  for (const t of pref) {
    const c = components.find(x => (x.types || []).includes(t));
    if (c?.long_name) return c.long_name;
  }
  return '';
}

async function geocode(address) {
  const url =
    `${MAPS_BASE}/geocode/json?address=${encodeURIComponent(address)}` +
    `&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Geocode HTTP ${r.status}`);
  return r.json();
}

async function placesTextSearch(query) {
  const url =
    `${MAPS_BASE}/place/textsearch/json?query=${encodeURIComponent(query)}` +
    `&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TextSearch HTTP ${r.status}`);
  return r.json();
}

async function nearbySearch({ lat, lng }, radius = 60) {
  if (!lat || !lng) return { results: [] };
  // type 用 | 分隔不被接受，因此發兩次請求、或先用一個最常見的類型
  const url =
    `${MAPS_BASE}/place/nearbysearch/json?location=${lat},${lng}` +
    `&radius=${radius}&type=premise&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Nearby HTTP ${r.status}`);
  return r.json();
}

async function placeDetails(placeId) {
  const fields = [
    'name',
    'formatted_address',
    'address_components',
    'geometry',
    'types',
  ].join(',');
  const url =
    `${MAPS_BASE}/place/details/json?place_id=${placeId}` +
    `&fields=${fields}&language=zh-TW&region=tw&key=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Details HTTP ${r.status}`);
  return r.json();
}

/**
 * geocodeAddress(raw): 回傳整合資訊
 * {
 *   ok: true/false,
 *   data: {
 *     fullCityDistrict,   // 例：新北市板橋區
 *     formattedAddress,   // 例：220 台灣新北市板橋區華江一路582號
 *     floor,              // 從原始輸入抓到的「幾樓」（可能為空）
 *     community,          // 社區/大樓名稱（盡量補到）
 *     sublocality,        // 次行政區（備用顯示）
 *     placeId,            // 主 place_id
 *     location: { lat, lng }
 *   },
 *   error
 * }
 */
async function geocodeAddress(raw = '') {
  if (!KEY) return { ok: false, error: 'Missing GOOGLE_MAPS_API_KEY' };

  const floor = extractFloor(raw);

  // 1) 先 geocode 取得標準地址、components、座標
  const g = await geocode(raw);
  const best = (g.results || [])[0];
  if (!best) return { ok: false, error: 'GEOCODE_ZERO_RESULTS' };

  const comps = best.address_components || [];
  // 去掉可能開頭的郵遞區號
  const formattedAddress = (best.formatted_address || '').replace(/^\d{3,5}\s*/, '');
  const location = best.geometry?.location || {};
  const placeId = best.place_id || '';
  const fullCityDistrict = cityDistrictFromComponents(comps);

  let community = pickCommunityFromComponents(comps);
  const sublocality =
    (comps.find(c => (c.types || []).includes('sublocality_level_1')) || {}).long_name ||
    (comps.find(c => (c.types || []).includes('sublocality')) || {}).long_name || '';

  // 2) 若還沒有社區/大樓名稱 → 用 Text Search 強化
  if (!community) {
    try {
      const t = await placesTextSearch(raw);
      const first = (t.results || [])[0];
      if (first?.place_id) {
        const d = await placeDetails(first.place_id);
        const p = d.result || {};
        const route = (p.address_components || []).find(c => (c.types || []).includes('route'))?.long_name || '';
        if (p.name && p.name.replace(/\s/g, '') !== route.replace(/\s/g, '')) {
          community = p.name;
        }
      }
    } catch (_) { /* 靜默忽略 */ }
  }

  // 3) 仍然沒有 → 以座標做 Nearby Search（60m 內抓最近的建築）
  if (!community && location?.lat && location?.lng) {
    try {
      const near = await nearbySearch(location, 60);
      const top = (near.results || []).find(x =>
        (x.types || []).includes('premise') || (x.types || []).includes('establishment')
      );
      if (top?.place_id) {
        const d2 = await placeDetails(top.place_id);
        const p2 = d2.result || {};
        const route2 = (p2.address_components || []).find(c => (c.types || []).includes('route'))?.long_name || '';
        if (p2.name && p2.name.replace(/\s/g, '') !== route2.replace(/\s/g, '')) {
          community = p2.name;
        }
      }
    } catch (_) { /* 靜默忽略 */ }
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
      location,
    },
  };
}

module.exports = { geocodeAddress };

