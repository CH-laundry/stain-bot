// services/geoClient.js
const fetch = require('node-fetch');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!GOOGLE_API_KEY) {
  console.warn('[geoClient] 缺少環境變數 GOOGLE_MAPS_API_KEY');
}

/**
 * 從 address_components 取出特定 type 的名稱
 */
function pickComp(components = [], typesWanted = []) {
  const hit = components.find(c => typesWanted.every(t => c.types.includes(t)));
  return hit ? hit.long_name : '';
}

/**
 * 從地址字串嘗試抓「樓層」資訊（中文/數字）
 * e.g. 4樓 / 四樓 / 之1 / 12F
 */
function extractFloor(raw = '') {
  const s = String(raw);
  // 之x 視為門牌分號，不當樓層
  const m1 = s.match(/([0-9]{1,2})\s*(?:樓|F)\b/);
  if (m1) return `${m1[1]}樓`;
  const m2 = s.match(/([一二三四五六七八九十]{1,3})\s*樓/);
  if (m2) return `${m2[1]}樓`;
  return '';
}

/**
 * 以「Find Place from Text」找 place_id
 */
async function findPlaceIdByText(input) {
  const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';
  const params = new URLSearchParams({
    input,
    inputtype: 'textquery',
    // 以 address/establishment 都能匹配；台灣優先
    fields: 'place_id',
    language: 'zh-TW',
    region: 'tw',
    key: GOOGLE_API_KEY,
  });
  const r = await fetch(`${url}?${params.toString()}`);
  const data = await r.json();
  if (data.status === 'OK' && data.candidates && data.candidates.length) {
    return data.candidates[0].place_id;
  }
  return null;
}

/**
 * 以 place_id 取 Place Details
 */
async function getPlaceDetails(placeId) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const params = new URLSearchParams({
    place_id: placeId,
    // name 可能就是社區/大樓名；同時拿到地址與 components
    fields: 'name,formatted_address,address_component,geometry',
    language: 'zh-TW',
    key: GOOGLE_API_KEY,
  });
  const r = await fetch(`${url}?${params.toString()}`);
  const data = await r.json();
  if (data.status === 'OK' && data.result) return data.result;
  return null;
}

/**
 * 後援：Geocoding（可幫忙標準化地址、取市+區）
 */
async function geocodeRawAddress(input) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json';
  const params = new URLSearchParams({
    address: input,
    language: 'zh-TW',
    region: 'tw',
    key: GOOGLE_API_KEY,
  });
  const r = await fetch(`${url}?${params.toString()}`);
  const data = await r.json();
  if (data.status === 'OK' && data.results && data.results.length) {
    return data.results[0];
  }
  return null;
}

/**
 * 主流程：輸入一句地址/社區名 → 回傳 { 市+區, 社區名, 標準地址, lat/lng, placeId, floor }
 */
async function geocodeAddress(inputText) {
  const raw = String(inputText || '').trim();
  if (!raw) return { ok: false, reason: 'EMPTY_INPUT' };

  try {
    // Step 1: 先用 Find Place 取 place_id（針對社區/大樓名命中率高）
    let placeId = await findPlaceIdByText(raw);

    // Step 2: 取詳細資料
    let pd = null;
    if (placeId) {
      pd = await getPlaceDetails(placeId);
    }

    // Step 3: 後援 Geocoding（幫忙標準化地址、取市+區）
    let geo = await geocodeRawAddress(raw);

    // 如果 Details 沒有 address，就再用 geocoding 的 formatted_address 補
    let formattedAddress =
      (pd && pd.formatted_address) ||
      (geo && geo.formatted_address) ||
      '';

    // 市 + 區
    let components = (pd && pd.address_components) || (geo && geo.address_components) || [];
    const city =
      pickComp(components, ['administrative_area_level_1']) || // 直轄市
      pickComp(components, ['administrative_area_level_2']);   // 縣市
    const district = pickComp(components, ['administrative_area_level_3']) ||
                     pickComp(components, ['administrative_area_level_2']); // 有些城市用 level_2 當區
    const fullCityDistrict = [city, district].filter(Boolean).join('');

    // sublocality（里/鄰/次分區）
    const sublocality =
      pickComp(components, ['sublocality_level_1']) ||
      pickComp(components, ['sublocality']) ||
      '';

    // 社區/大樓名稱：以 Place Details 的 name 為主
    // 若 name 與 formatted_address高度一致（純地址），則視為無社區名
    let community = '';
    if (pd && pd.name) {
      const nm = pd.name.trim();
      const fa = (formattedAddress || '').trim();
      if (!fa || (fa && !fa.includes(nm))) {
        community = nm;
      } else {
        // 有時 name 也會等於門牌，做個寬鬆判斷
        const shortFa = fa.replace(/\s/g, '');
        const shortNm = nm.replace(/\s/g, '');
        if (!shortFa.includes(shortNm)) community = nm;
      }
    }

    // lat/lng
    const lat = (pd && pd.geometry && pd.geometry.location && pd.geometry.location.lat) ||
                (geo && geo.geometry && geo.geometry.location && geo.geometry.location.lat) ||
                null;
    const lng = (pd && pd.geometry && pd.geometry.location && pd.geometry.location.lng) ||
                (geo && geo.geometry && geo.geometry.location && geo.geometry.location.lng) ||
                null;

    // 如果還沒有 placeId，嘗試從 geocode result 裡拿（有時 geocode 也會回 place_id）
    if (!placeId && geo && geo.place_id) placeId = geo.place_id;

    // 樓層（從原始輸入與 formattedAddress 嘗試抓）
    const floor = extractFloor(raw) || extractFloor(formattedAddress);

    return {
      ok: true,
      data: {
        placeId: placeId || '',
        formattedAddress,
        fullCityDistrict,
        community,         // ← 社區/大樓名（可能為空字串）
        sublocality,
        lat, lng,
        floor,
      }
    };
  } catch (err) {
    console.error('[geoClient] geocodeAddress error', err);
    return { ok: false, reason: 'EXCEPTION', error: String(err?.message || err) };
  }
}

module.exports = { geocodeAddress };
