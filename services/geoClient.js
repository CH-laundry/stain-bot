// services/geoClient.js
// 功能：把地址丟給 Google Geocoding API，解析「市、區、里/次分區、社區/大樓名稱」
// 依據「區」判斷是否屬於免費收送範圍

const fetch = require('node-fetch');

const FREE_PICKUP_AREAS = ['板橋區', '中和區', '永和區', '新莊區', '土城區', '萬華區']; // 雙和→中和/永和已涵蓋

function getComp(components, type) {
  const c = components.find((x) => x.types.includes(type));
  return c ? c.long_name : '';
}
function getAnyComp(components, types = []) {
  for (const t of types) {
    const v = getComp(components, t);
    if (v) return v;
  }
  return '';
}

function parseAddressComponents(components = []) {
  const country = getComp(components, 'country'); // 台灣
  const admin1 = getComp(components, 'administrative_area_level_1'); // 直轄市/縣市（臺北市/新北市）
  // 行政區（district）：有時在 administrative_area_level_2、有時在 locality
  const district = getAnyComp(components, ['administrative_area_level_2', 'locality', 'postal_town']);
  // 次分區（里/鄰/地區）可能出現在 sublocality 或 neighborhood
  const sublocality = getAnyComp(components, ['sublocality_level_2', 'sublocality_level_1', 'sublocality', 'neighborhood']);
  // 社區/大樓名稱（若有資料會在 premise / establishment / neighborhood 之類）
  const community = getAnyComp(components, ['premise', 'establishment', 'point_of_interest', 'neighborhood']);

  const route = getComp(components, 'route'); // 路名
  const streetNumber = getComp(components, 'street_number'); // 門牌
  const postalCode = getComp(components, 'postal_code');

  return {
    country,
    city: admin1 || '',
    district: district || '',
    sublocality: sublocality || '',
    community: community || '',
    route,
    streetNumber,
    postalCode,
  };
}

function makeFullCityDistrict(city, district) {
  if (city && district) return `${city}${district}`;
  if (city) return city;
  return district || '';
}

function isFreePickup(district) {
  return FREE_PICKUP_AREAS.includes(district);
}

/**
 * 以地址文字呼叫 Geocoding API
 * @param {string} address 使用者輸入地址
 * @returns {Promise<{ ok:boolean, reason?:string, data?:object }>}
 */
async function geocodeAddress(address) {
  if (!address) return { ok: false, reason: 'EMPTY_ADDRESS' };
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { ok: false, reason: 'NO_API_KEY' };

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('language', 'zh-TW');
  url.searchParams.set('region', 'tw');
  url.searchParams.set('key', key);

  const resp = await fetch(url.toString(), { timeout: 15000 });
  if (!resp.ok) return { ok: false, reason: `HTTP_${resp.status}` };

  const json = await resp.json();
  if (json.status !== 'OK' || !json.results?.length) {
    return { ok: false, reason: json.status || 'NO_RESULTS' };
  }

  const best = json.results[0]; // 最匹配結果
  const components = best.address_components || [];
  const parsed = parseAddressComponents(components);

  const fullCityDistrict = makeFullCityDistrict(parsed.city, parsed.district);
  const free = isFreePickup(parsed.district);

  return {
    ok: true,
    data: {
      input: address,
      formattedAddress: best.formatted_address || '',
      location: best.geometry?.location || null, // { lat, lng }
      placeId: best.place_id || '',
      city: parsed.city,
      district: parsed.district,
      sublocality: parsed.sublocality,
      community: parsed.community,
      route: parsed.route,
      streetNumber: parsed.streetNumber,
      postalCode: parsed.postalCode,
      fullCityDistrict,
      isFreePickup: free,
    },
  };
}

module.exports = {
  geocodeAddress,
  isFreePickup,
};
