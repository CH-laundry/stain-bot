// services/geoClient.js
const fetch = require('node-fetch');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!GOOGLE_MAPS_API_KEY) {
  console.warn('[geoClient] Missing GOOGLE_MAPS_API_KEY');
}

/* ---------------- In-Memory Cache ---------------- */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const cache = new Map();
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  const { data, ts } = hit;
  if (Date.now() - ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

/* ---------------- Helpers ---------------- */
const COMMUNITY_NAME_RE =
  /(社區|大樓|廣場|園區|花園|天廈|帝景|苑|城|園|峰|莊|會館|名人|首席|御|官邸|國宅|社宅|之森|世界|悅|馥|璽|晶華|凱旋|御品|首府|國際|中心|金融|企業|商務|商業|百貨)/;

function isLikelyCommunityName(name = '', route = '') {
  if (!name) return false;
  // 排除「○○市/區/鄉/鎮/里/村」或純道路名
  if (/[市區鄉鎮里村]$/.test(name)) return false;
  if (/^.+(路|街|大道|巷|弄)$/.test(name)) return false;
  // 避免把「路名」本身當成社區
  if (route && name.replace(/\s/g, '') === route.replace(/\s/g, '')) return false;
  // 關鍵字 or 專有名詞（>=3字）
  return COMMUNITY_NAME_RE.test(name) || name.length >= 3;
}

function pickAddressComponent(components = [], type) {
  return components.find(c => c.types.includes(type))?.long_name || '';
}

function buildFullCityDistrict(components = []) {
  // 台灣常見：administrative_area_level_1 = 直轄市/縣；level_2/3 = 區
  const city =
    pickAddressComponent(components, 'administrative_area_level_1') ||
    pickAddressComponent(components, 'administrative_area_level_2');
  const district =
    pickAddressComponent(components, 'administrative_area_level_2') ||
    pickAddressComponent(components, 'administrative_area_level_3') ||
    pickAddressComponent(components, 'postal_town');
  // 避免重複：若 city == district，就只要 city
  if (city && district && city !== district) return `${city}${district}`;
  return city || district || '';
}

/* ---------------- Core: geocodeAddress ---------------- */
async function geocodeAddress(input) {
  if (!input || !GOOGLE_MAPS_API_KEY) {
    return { ok: false, error: '缺少地址或 API KEY' };
  }

  const cacheKey = `geo:${input}`;
  const hit = getCache(cacheKey);
  if (hit) return { ok: true, data: hit, cached: true };

  try {
    /* 1) Geocoding：把文字 → 座標 + 元件 */
    const geoUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    geoUrl.searchParams.set('address', input);
    geoUrl.searchParams.set('language', 'zh-TW');
    geoUrl.searchParams.set('region', 'tw');
    geoUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY);

    const geoRes = await fetch(geoUrl.toString());
    const geoData = await geoRes.json();

    if (geoData.status !== 'OK' || !Array.isArray(geoData.results) || !geoData.results.length) {
      return { ok: false, error: geoData.error_message || '查無此地址' };
    }

    const result = geoData.results[0];
    const placeId = result.place_id;
    const formattedAddress = result.formatted_address || '';
    const components = result.address_components || [];
    const location = result.geometry?.location || {};
    const lat = location.lat;
    const lng = location.lng;

    const route =
      pickAddressComponent(components, 'route') ||
      pickAddressComponent(components, 'point_of_interest');

    // 次行政區（如「○○里」「○○里/○○段」常被標為 sublocality 或 neighborhood）
    const sublocality =
      pickAddressComponent(components, 'sublocality') ||
      pickAddressComponent(components, 'neighborhood') ||
      pickAddressComponent(components, 'sublocality_level_1');

    const fullCityDistrict = buildFullCityDistrict(components);

    /* 2) Place Details：用 place_id 抓可能的大樓/社區名稱 */
    let community = '';
    if (placeId) {
      const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      detailsUrl.searchParams.set('place_id', placeId);
      detailsUrl.searchParams.set('language', 'zh-TW');
      detailsUrl.searchParams.set('fields', 'name,types,formatted_address');
      detailsUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY);

      const detRes = await fetch(detailsUrl.toString());
      const detData = await detRes.json();
      const name = detData?.result?.name;
      if (name && isLikelyCommunityName(name, route)) {
        community = name.trim();
      }
    }

    /* 3) Nearby Search 兜底：以座標為中心，半徑 80m 搜「大樓/社區」 */
    if (!community && lat != null && lng != null) {
      const nearbyUrl = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
      nearbyUrl.searchParams.set('location', `${lat},${lng}`);
      nearbyUrl.searchParams.set('radius', '80'); // 可視情況 80~120
      // 關鍵字：常見社區/大樓詞
      nearbyUrl.searchParams.set('keyword', '社區 大樓 廣場 園區 花園 帝景 悅 名人 首府 首席 國際 企業 中心');
      nearbyUrl.searchParams.set('language', 'zh-TW');
      nearbyUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY);

      const nearRes = await fetch(nearbyUrl.toString());
      const nearData = await nearRes.json();

      if (nearData.status === 'OK' && Array.isArray(nearData.results)) {
        // 取最接近的一個
        const cand = nearData.results[0];
        const candName = cand?.name;
        if (candName && isLikelyCommunityName(candName, route)) {
          community = candName.trim();
        }
      }
    }

    /* 4) Find Place From Text 兜底：用整串地址再問一次 */
    if (!community && formattedAddress) {
      const findUrl = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
      findUrl.searchParams.set('input', formattedAddress);
      findUrl.searchParams.set('inputtype', 'textquery');
      findUrl.searchParams.set('fields', 'name,geometry,types');
      findUrl.searchParams.set('language', 'zh-TW');
      findUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY);

      const findRes = await fetch(findUrl.toString());
      const findData = await findRes.json();
      if (findData.status === 'OK' && Array.isArray(findData.candidates) && findData.candidates.length) {
        const cand = findData.candidates[0];
        const candName = cand?.name;
        if (candName && isLikelyCommunityName(candName, route)) {
          community = candName.trim();
        }
      }
    }

    const payload = {
      formattedAddress,
      fullCityDistrict,
      sublocality,
      route,
      community,
      lat,
      lng,
    };

    setCache(cacheKey, payload);
    return { ok: true, data: payload };
  } catch (err) {
    console.error('[geoClient] geocodeAddress error:', err);
    return { ok: false, error: err.message || 'unknown error' };
  }
}

module.exports = { geocodeAddress };
