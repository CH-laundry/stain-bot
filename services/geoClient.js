// services/geoClient.js
// 需求：node-fetch（你專案已在用）
// 功能：把地址丟給 Google Geocoding，解析市/區/路/門牌；再用 Places 取「社區/大樓」名稱
// 重要：請在環境變數設定 GOOGLE_MAPS_API_KEY，並在 GCP 啟用 Geocoding API + Places API

const fetch = require('node-fetch');

// 可自行增補關鍵字；用來判斷名稱是否像社區/大樓（而非行政區）
const COMMUNITY_NAME_RE =
  /(社區|大樓|廣場|園區|花園|天廈|帝景|苑|城|園|峰|莊|會館|名人|首席|御|官邸|國宅|社宅|之森|世界|悅|馥|璽|首席|晶華|凱旋|御品|首府)/;

function isLikelyCommunityName(name = '', route = '') {
  if (!name) return false;
  // 避免抓成「板橋區 / 信義區 / ○○里」
  if (/[市區鄉鎮里村]$/.test(name)) return false;
  // 名稱與路名完全相同通常不是社區名（例如「華江一路」）
  if (route && name.replace(/\s/g, '') === route.replace(/\s/g, '')) return false;
  // 關鍵字或長度>=3（例如「帝景苑」「名人」等）
  return COMMUNITY_NAME_RE.test(name) || name.length >= 3;
}

function pickComp(components, type) {
  const c = components.find(x => x.types?.includes(type));
  return c ? c.long_name : '';
}
function pickAny(components, types = []) {
  for (const t of types) {
    const v = pickComp(components, t);
    if (v) return v;
  }
  return '';
}

// 你有用到是否免費收送，但目前訊息不顯示；保留欄位以便未來使用
const FREE_PICKUP_AREAS = ['板橋區', '中和區', '永和區', '新莊區', '土城區', '萬華區'];

function isFreePickup(district) {
  return FREE_PICKUP_AREAS.includes(district);
}

async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { ok: false, error: 'NO_API_KEY (缺少 GOOGLE_MAPS_API_KEY)' };
  if (!address) return { ok: false, error: 'EMPTY_ADDRESS' };

  try {
    // 1) Geocoding：先把地址解析出市/區/路/門牌與 place_id、座標
    const geoUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    geoUrl.searchParams.set('address', address);
    geoUrl.searchParams.set('language', 'zh-TW');
    geoUrl.searchParams.set('region', 'tw');
    geoUrl.searchParams.set('key', apiKey);

    const geoRes = await fetch(geoUrl.toString());
    if (!geoRes.ok) return { ok: false, error: `HTTP_${geoRes.status}` };
    const geoData = await geoRes.json();

    if (geoData.status !== 'OK' || !Array.isArray(geoData.results) || !geoData.results.length) {
      return { ok: false, error: `GEOCODE_${geoData.status || 'NO_RESULTS'}` };
    }

    const best = geoData.results[0];
    const components = best.address_components || [];
    const location = best.geometry?.location || null;
    const placeId = best.place_id || '';

    // 抽取各層級
    const country   = pickComp(components, 'country'); // 台灣
    const city      = pickComp(components, 'administrative_area_level_1'); // 新北市/臺北市
    // district 有時在 level_2、有時在 locality（Google 在台灣資料常見兩種）
    const district  = pickAny(components, ['administrative_area_level_2', 'locality', 'postal_town']);
    const sublocality = pickAny(components, ['sublocality_level_2', 'sublocality_level_1', 'sublocality', 'neighborhood']);
    const route     = pickComp(components, 'route');           // 華江一路
    const streetNum = pickComp(components, 'street_number');   // 582號
    const postal    = pickComp(components, 'postal_code');
    const formattedAddress = best.formatted_address || '';

    // 初步社區名稱（Geocoding 自帶欄位）
    let community = pickAny(components, ['premise', 'establishment', 'subpremise', 'neighborhood', 'sublocality_level_2']) || '';

    // 2) Places Details：若尚未抓到，嘗試用 place_id 取得更「像社區/大樓」的 name
    if (!community && placeId) {
      const detailUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      detailUrl.searchParams.set('place_id', placeId);
      detailUrl.searchParams.set('fields', 'name,types');
      detailUrl.searchParams.set('language', 'zh-TW');
      detailUrl.searchParams.set('key', apiKey);

      const detRes = await fetch(detailUrl.toString());
      const detData = await detRes.json();
      if (detData.status === 'OK' && detData.result?.name) {
        const name = detData.result.name.trim();
        if (isLikelyCommunityName(name, route)) {
          community = name;
        }
      }
    }

    // 3) Nearby Search 備援：Details 也沒抓到時，以 80m 圓域搜尋鄰近「像社區/大樓」的名稱
    if (!community && location?.lat && location?.lng) {
      const nearbyUrl = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
      nearbyUrl.searchParams.set('location', `${location.lat},${location.lng}`);
      nearbyUrl.searchParams.set('radius', '80');                 // 60~100m 自行調整
      nearbyUrl.searchParams.set('type', 'establishment');
      nearbyUrl.searchParams.set('language', 'zh-TW');
      nearbyUrl.searchParams.set('key', apiKey);

      const nearRes = await fetch(nearbyUrl.toString());
      const nearData = await nearRes.json();
      if (nearData.status === 'OK' && Array.isArray(nearData.results) && nearData.results.length) {
        const candidate =
          nearData.results.find(r => isLikelyCommunityName(r.name, route)) || nearData.results[0];
        if (candidate?.name && isLikelyCommunityName(candidate.name, route)) {
          community = candidate.name.trim();
        }
      }
    }

    const fullCityDistrict = `${city || ''}${district || ''}`; // 例如：新北市板橋區
    const free = isFreePickup(district);

    return {
      ok: true,
      data: {
        input: address,
        formattedAddress,
        placeId,
        location,            // { lat, lng }
        country,
        city,
        district,
        sublocality,
        route,
        streetNumber: streetNum,
        postalCode: postal,
        fullCityDistrict,    // 你在 message.js 會印成「📍 新北市板橋區」
        community,           // 你在 message.js 會印成「🏢 社區/大樓：×××」
        isFreePickup: free,  // 目前訊息不顯示，但留著以後要用
      }
    };
  } catch (err) {
    console.error('[geocodeAddress error]', err);
    return { ok: false, error: err.message || 'UNKNOWN_ERROR' };
  }
}

module.exports = {
  geocodeAddress
};
