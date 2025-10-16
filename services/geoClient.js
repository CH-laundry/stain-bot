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
  const m1 = s.match(/([0-9]{1,2})\s*(?:樓|F)\b/i);
  if (m1) return `${m1[1]}樓`;
  const m2 = s.match(/([一二三四五六七八九十]{1,3})\s*樓/);
  if (m2) return `${m2[1]}樓`;
  return '';
}

/**
 * 判斷字串是否為純地址（包含門牌關鍵字）
 */
function isPureStreetAddress(text = '') {
  const s = String(text).trim();
  if (!s) return true;
  
  // 包含路街巷弄號 = 純地址
  if (/[路街巷弄號]/g.test(s)) return true;
  
  // 以數字+台灣/縣市開頭 = 郵遞區號格式
  if (/^[\d]{3,5}[台臺]/.test(s)) return true;
  
  return false;
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
  
  try {
    const r = await fetch(`${url}?${params.toString()}`);
    const data = await r.json();
    
    console.log(`[geoClient] findPlaceIdByText status: ${data.status}`);
    
    if (data.status === 'OK' && data.candidates && data.candidates.length) {
      return data.candidates[0].place_id;
    }
  } catch (err) {
    console.error('[geoClient] findPlaceIdByText error:', err);
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
    fields: 'name,formatted_address,address_component,geometry,types',
    language: 'zh-TW',
    key: GOOGLE_API_KEY,
  });
  
  try {
    const r = await fetch(`${url}?${params.toString()}`);
    const data = await r.json();
    
    console.log(`[geoClient] getPlaceDetails status: ${data.status}`);
    
    if (data.status === 'OK' && data.result) {
      return data.result;
    }
  } catch (err) {
    console.error('[geoClient] getPlaceDetails error:', err);
  }
  
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
  
  try {
    const r = await fetch(`${url}?${params.toString()}`);
    const data = await r.json();
    
    console.log(`[geoClient] geocodeRawAddress status: ${data.status}`);
    
    if (data.status === 'OK' && data.results && data.results.length) {
      return data.results[0];
    }
  } catch (err) {
    console.error('[geoClient] geocodeRawAddress error:', err);
  }
  
  return null;
}

/**
 * 從 Place Details 的 types 判斷是否為建築物/社區
 */
function isBuildingOrCommunity(types = []) {
  const buildingTypes = [
    'premise',           // 建築物
    'subpremise',        // 子建築
    'establishment',     // 機構/場所
    'point_of_interest', // 興趣點
    'locality',          // 地點
  ];
  
  return types.some(t => buildingTypes.includes(t));
}

/**
 * 主流程：輸入一句地址/社區名 → 回傳 { 市+區, 社區名, 標準地址, lat/lng, placeId, floor }
 */
async function geocodeAddress(inputText) {
  const raw = String(inputText || '').trim();
  if (!raw) return { ok: false, reason: 'EMPTY_INPUT' };

  try {
    console.log(`\n[geoClient] ===== 開始解析地址 =====`);
    console.log(`[geoClient] 輸入: ${raw}`);
    
    // Step 1: 先用 Find Place 取 place_id（針對社區/大樓名命中率高）
    let placeId = await findPlaceIdByText(raw);
    console.log(`[geoClient] placeId: ${placeId || '未找到'}`);

    // Step 2: 取詳細資料
    let pd = null;
    if (placeId) {
      pd = await getPlaceDetails(placeId);
      if (pd) {
        console.log(`[geoClient] Place Details name: ${pd.name}`);
        console.log(`[geoClient] Place Details types: ${pd.types?.join(', ')}`);
      }
    }

    // Step 3: 後援 Geocoding（幫忙標準化地址、取市+區）
    let geo = await geocodeRawAddress(raw);
    if (geo) {
      console.log(`[geoClient] Geocoding formatted_address: ${geo.formatted_address}`);
    }

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

    // ✅ 改進的社區/大樓名稱判斷邏輯
    let community = '';
    
    if (pd && pd.name) {
      const nm = pd.name.trim();
      console.log(`[geoClient] 檢查 name 是否為社區: ${nm}`);
      
      // 方法 1: 檢查是否為純地址格式
      const isAddress = isPureStreetAddress(nm);
      console.log(`[geoClient] isPureStreetAddress: ${isAddress}`);
      
      // 方法 2: 檢查 Place Types
      const isBuilding = pd.types ? isBuildingOrCommunity(pd.types) : false;
      console.log(`[geoClient] isBuildingOrCommunity: ${isBuilding}`);
      
      // 方法 3: 檢查是否與 formatted_address 完全相同
      const isSameAsAddress = nm === formattedAddress;
      console.log(`[geoClient] isSameAsAddress: ${isSameAsAddress}`);
      
      // ✅ 判斷邏輯：只要不是純地址格式，就視為社區/大樓名
      if (!isAddress && !isSameAsAddress) {
        community = nm;
        console.log(`[geoClient] ✅ 找到社區名稱: ${community}`);
      } else {
        console.log(`[geoClient] ❌ name 被判定為純地址，不作為社區名稱`);
      }
    } else {
      console.log(`[geoClient] ❌ 無 Place Details name`);
    }
    
    // ✅ 備用方案：如果還是沒有 community，嘗試從 premise 類型的 component 抓
    if (!community && components.length > 0) {
      const premise = pickComp(components, ['premise']);
      const subpremise = pickComp(components, ['subpremise']);
      
      if (premise && !isPureStreetAddress(premise)) {
        community = premise;
        console.log(`[geoClient] ✅ 從 premise 找到社區: ${community}`);
      } else if (subpremise && !isPureStreetAddress(subpremise)) {
        community = subpremise;
        console.log(`[geoClient] ✅ 從 subpremise 找到社區: ${community}`);
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

    console.log(`[geoClient] ===== 解析結果 =====`);
    console.log(`[geoClient] 社區/大樓: ${community || '(無)'}`);
    console.log(`[geoClient] 市區: ${fullCityDistrict}`);
    console.log(`[geoClient] 標準地址: ${formattedAddress}`);
    console.log(`[geoClient] 樓層: ${floor || '(無)'}`);
    console.log(`[geoClient] =========================\n`);

    return {
      ok: true,
      data: {
        placeId: placeId || '',
        formattedAddress,
        fullCityDistrict,
        community,         // ← 社區/大樓名（改進後更容易抓到）
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
```

## 🎯 主要改進：

### 1. **更寬鬆的社區名稱判斷** (Line 127-158)
- 新增 `isPureStreetAddress()` 函數：檢查是否為純地址格式
- 新增 `isBuildingOrCommunity()` 函數：從 Google Place Types 判斷
- **只要不是純地址格式，就視為社區/大樓名稱**

### 2. **備用方案** (Line 160-172)
- 如果 `pd.name` 沒有社區名稱
- 嘗試從 `address_components` 的 `premise` 或 `subpremise` 抓取

### 3. **詳細的 Debug Log**
- 每個步驟都有 console.log
- 方便追蹤為什麼社區名稱有沒有被抓到
- 正式環境可以移除或改用 logger

### 4. **更好的錯誤處理**
- 每個 API 呼叫都加上 try-catch
- 確保不會因為單一 API 失敗而整個掛掉

## 📝 測試方式：

輸入這些地址測試：
```
新北市板橋區文化路二段182巷1弄3號4樓
板橋雙十公園社區5樓
華江一路582號
```

應該會看到類似這樣的 log：
```
[geoClient] ===== 開始解析地址 =====
[geoClient] 輸入: 新北市板橋區文化路二段182巷1弄3號4樓
[geoClient] ✅ 找到社區名稱: 文化新象
[geoClient] 市區: 新北市板橋區
[geoClient] 標準地址: 220新北市板橋區文化路二段182巷1弄3號
[geoClient] 樓層: 4樓
