// services/geoClient.js
const fetch = require('node-fetch');

/**
 * 同步呼叫 Google Maps Geocoding API，回傳行政區、大樓/社區與是否屬於免費收送範圍
 * 並搭配 Places API 抓出大樓或社區名稱。
 */
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { ok: false, error: '缺少 GOOGLE_MAPS_API_KEY' };

  try {
    // 1️⃣ 先使用 Geocoding 解析地址
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&key=${apiKey}`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();

    if (geoData.status !== 'OK' || !geoData.results?.length) {
      return { ok: false, error: `Geocode失敗: ${geoData.status}` };
    }

    const result = geoData.results[0];
    const components = result.address_components;
    const formattedAddress = result.formatted_address;
    const location = result.geometry?.location || {};

    // 2️⃣ 萃取行政區
    const find = type => (components.find(c => c.types.includes(type)) || {}).long_name || '';
    const fullCityDistrict = `${find('administrative_area_level_1')}${find('administrative_area_level_2')}${find('locality')}${find('sublocality_level_1')}`;
    const sublocality = find('sublocality_level_2') || find('neighborhood') || '';

    // 3️⃣ 嘗試從 Geocoding 結果裡直接找出 place_id
    const placeId = result.place_id;

    // 4️⃣ 再用 Places API 查詢該地點（可能是大樓或社區名稱）
    let community = '';
    if (placeId) {
      const placeUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,types&language=zh-TW&key=${apiKey}`;
      const placeRes = await fetch(placeUrl);
      const placeData = await placeRes.json();

      if (placeData.status === 'OK' && placeData.result?.name) {
        const name = placeData.result.name.trim();
        // 過濾掉純地名（例如「板橋區」、「台北市」）
        if (!/市|區|鄉|鎮|里|村$/.test(name)) {
          community = name;
        }
      }
    }

    // 5️⃣ 判斷是否屬於 C.H 精緻洗衣免費收送範圍
    const isFreePickup = /板橋|中和|永和|新莊|土城|萬華|雙和/.test(fullCityDistrict);

    return {
      ok: true,
      data: {
        formattedAddress,
        fullCityDistrict,
        community,
        sublocality,
        latitude: location.lat,
        longitude: location.lng,
        isFreePickup
      }
    };
  } catch (err) {
    console.error('[Geocode Error]', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { geocodeAddress };
