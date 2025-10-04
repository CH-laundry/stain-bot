// services/openai.js
const { OpenAI } = require("openai");
const crypto = require('crypto');

// ============ 環境變數檢查 ============
if (!process.env.OPENAI_API_KEY) {
  throw new Error("❌ 缺少 OPENAI_API_KEY 環境變數");
}

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 固定連結（可 .env 覆寫）
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const BUSINESS_HOURS_TEXT_ENV = process.env.BUSINESS_HOURS_TEXT || "";
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
const USE_MOCK = process.env.USE_MOCK === 'true';

// ============ 快取機制 ============
const brandCache = new Map();
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24小時

// ============ 日誌工具 ============
function log(type, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`, data ? data : '');
}

/* ---------------- 共用小工具 ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function normalize(s = "") {
  const fw = "０１２３４５６７８９";
  const hw = "0123456789";
  return (s || "").replace(/[０-９]/g, (c) => hw[fw.indexOf(c)]).trim();
}

function isEmojiOrPuncOnly(s = "") {
  const t = (s || "").trim();
  if (!t) return true;
  const stripped = t.replace(
    /[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}\s、，。．。！？!?.…~\-—_()*^%$#@＋+／/\\|:;"'<>【】\[\]{}]/gu,
    ""
  );
  return stripped.length === 0;
}

function maybeLaundryRelated(s = "") {
  const t = normalize(s).toLowerCase();
  const kw = [
    "洗","清洗","乾洗","去污","污漬","汙漬","髒","變色","染色","退色","泛黃","發霉",
    "衣","衣服","外套","襯衫","褲","大衣","羽絨","毛衣","皮衣","針織","拉鍊","鈕扣",
    "包","包包","名牌包","手提袋","背包","書包","皮革","帆布","麂皮",
    "鞋","球鞋","運動鞋","皮鞋","靴","涼鞋","鞋墊","除臭",
    "窗簾","布簾","遮光簾","地毯","地墊","毯子","毛毯","被子","羽絨被","棉被",
    "帽子","毛帽","棒球帽","鴨舌帽","禮帽",
    "收衣","收件","到府","上門","取件","配送","預約",
    "時間","幾天","要多久","進度","洗好了嗎","可以拿了嗎","完成了嗎","查進度",
    "付款","結帳","信用卡","line pay","支付","匯款",
    "地址","住址","幾樓","樓層",
    "手推車","推車","嬰兒車","汽座","安全座椅",
    "營業","開門","關門","打烊","幾點開","幾點關","今天有開","今日有開",
    "優惠","活動","折扣","促銷","特價",
    "laundry","wash","dry clean","stain","pickup","delivery","address","payment","status","hours","open","close","promo","discount"
  ];
  return kw.some((k) => t.includes(k));
}

function extractTWAddress(text = "") {
  const re =
    /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,30}?(?:區|市|鎮|鄉)[^，。\s]{0,30}?(?:路|街|大道|巷|弄)[0-9]{1,4}號(?:之[0-9]{1,2})?(?:[，,\s]*(?:[0-9]{1,2}樓(?:之[0-9]{1,2})?|[0-9]{1,2}F))?/i;
  
  // 新增：支援地下樓層
  const re2 = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣).*?[0-9]{1,4}號.*?(?:B[0-9]{1,2}|地下[0-9]{1,2}樓)/i;
  
  const m = text.match(re) || text.match(re2);
  return m ? m[0].replace(/\s+/g, "") : "";
}

function reducePercentages(s, delta = 5) {
  return s.replace(/(\d{1,3})\s*%/g, (m, p1) => {
    let n = parseInt(p1, 10);
    if (!Number.isNaN(n) && n > 5) n = Math.max(n - delta, 1);
    return `${n}%`;
  });
}

// 改進：考慮時區的週六判斷
const isSaturday = () => {
  const now = new Date();
  const taiwanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanTime.getDay() === 6;
};

/* ---------------- 品牌名稱標準化與 JSON 安全解析 ---------------- */
const BRAND_MAP = {
  // ========== 精品包包品牌 ==========
  "lv": "Louis Vuitton", "louis vuitton": "Louis Vuitton", "路易威登": "Louis Vuitton", "lv包": "Louis Vuitton",
  "chanel": "Chanel", "香奈兒": "Chanel", "香奈儿": "Chanel",
  "gucci": "Gucci", "古馳": "Gucci", "古驰": "Gucci",
  "hermes": "Hermès", "hermès": "Hermès", "愛馬仕": "Hermès", "爱马仕": "Hermès",
  "prada": "Prada", "普拉達": "Prada", "普拉达": "Prada",
  "dior": "Dior", "迪奧": "Dior", "迪奥": "Dior",
  "fendi": "Fendi", "芬迪": "Fendi", "芬地": "Fendi",
  "bottega veneta": "Bottega Veneta", "bv": "Bottega Veneta", "寶緹嘉": "Bottega Veneta", "bv包": "Bottega Veneta",
  "celine": "Celine", "思琳": "Celine", "賽琳": "Celine",
  "ysl": "Saint Laurent", "saint laurent": "Saint Laurent", "聖羅蘭": "Saint Laurent", "圣罗兰": "Saint Laurent",
  "balenciaga": "Balenciaga", "巴黎世家": "Balenciaga", "巴黎士家": "Balenciaga",
  "givenchy": "Givenchy", "紀梵希": "Givenchy", "纪梵希": "Givenchy",
  "loewe": "Loewe", "羅意威": "Loewe", "罗意威": "Loewe",
  "valentino": "Valentino", "華倫天奴": "Valentino", "华伦天奴": "Valentino",
  "burberry": "Burberry", "巴寶莉": "Burberry", "博柏利": "Burberry",
  "goyard": "Goyard", "戈雅": "Goyard",
  "miu miu": "Miu Miu", "miumiu": "Miu Miu", "繆繆": "Miu Miu",
  "mcm": "MCM",
  "coach": "Coach", "蔻馳": "Coach", "寇茲": "Coach",
  "michael kors": "Michael Kors", "mk": "Michael Kors", "麥可·寇斯": "Michael Kors",
  "longchamp": "Longchamp", "瓏驤": "Longchamp", "珑骧": "Longchamp",
  "kate spade": "Kate Spade", "凱特絲蓓": "Kate Spade",
  "tory burch": "Tory Burch", "湯麗柏琦": "Tory Burch",
  "furla": "Furla", "芙拉": "Furla",
  "mulberry": "Mulberry", "瑪百莉": "Mulberry",
  
  // ========== 運動鞋品牌 ==========
  "nike": "Nike", "耐吉": "Nike", "耐克": "Nike",
  "adidas": "Adidas", "愛迪達": "Adidas", "阿迪達斯": "Adidas",
  "new balance": "New Balance", "nb": "New Balance", "紐巴倫": "New Balance", "新百倫": "New Balance",
  "puma": "Puma", "彪馬": "Puma",
  "asics": "Asics", "亞瑟士": "Asics", "亞瑟膠": "Asics",
  "converse": "Converse", "匡威": "Converse",
  "vans": "Vans", "范斯": "Vans",
  "reebok": "Reebok", "銳跑": "Reebok",
  "under armour": "Under Armour", "ua": "Under Armour", "安德瑪": "Under Armour",
  "skechers": "Skechers", "斯凱奇": "Skechers",
  "fila": "Fila", "斐樂": "Fila",
  "mizuno": "Mizuno", "美津濃": "Mizuno",
  "hoka": "Hoka", "hoka one one": "Hoka",
  "on running": "On", "on": "On", "昂跑": "On",
  "salomon": "Salomon", "薩洛蒙": "Salomon",
  "brooks": "Brooks",
  
  // ========== 精品鞋履品牌 ==========
  "jimmy choo": "Jimmy Choo", "周仰傑": "Jimmy Choo",
  "manolo blahnik": "Manolo Blahnik", "馬諾洛": "Manolo Blahnik",
  "christian louboutin": "Christian Louboutin", "cl": "Christian Louboutin", "紅底鞋": "Christian Louboutin", "羅布廷": "Christian Louboutin",
  "salvatore ferragamo": "Salvatore Ferragamo", "ferragamo": "Salvatore Ferragamo", "菲拉格慕": "Salvatore Ferragamo",
  "tod's": "Tod's", "tods": "Tod's", "托德斯": "Tod's",
  "roger vivier": "Roger Vivier", "羅傑·維維亞": "Roger Vivier",
  "giuseppe zanotti": "Giuseppe Zanotti", "朱塞佩·薩諾第": "Giuseppe Zanotti",
  "sergio rossi": "Sergio Rossi", "塞喬·羅西": "Sergio Rossi",
  "stuart weitzman": "Stuart Weitzman", "斯圖爾特·韋茨曼": "Stuart Weitzman",
  "clarks": "Clarks", "其樂": "Clarks",
  "timberland": "Timberland", "添柏嵐": "Timberland", "踢不爛": "Timberland",
  "dr. martens": "Dr. Martens", "dr martens": "Dr. Martens", "馬汀大夫": "Dr. Martens", "馬丁鞋": "Dr. Martens",
  "ugg": "UGG", "雪靴": "UGG",
  "birkenstock": "Birkenstock", "勃肯": "Birkenstock",
  "crocs": "Crocs", "卡駱馳": "Crocs", "布希鞋": "Crocs",
  
  // ========== 服飾品牌 ==========
  "uniqlo": "Uniqlo", "優衣庫": "Uniqlo",
  "zara": "Zara", "颯拉": "Zara",
  "h&m": "H&M", "hm": "H&M",
  "gap": "Gap",
  "muji": "Muji", "無印良品": "Muji",
  "gu": "GU",
  "mango": "Mango", "芒果": "Mango",
  "massimo dutti": "Massimo Dutti", "麥絲瑪拉": "Massimo Dutti",
  "cos": "COS",
  "pull & bear": "Pull & Bear", "pull&bear": "Pull & Bear",
  "bershka": "Bershka",
  
  // ========== 精品服飾品牌 ==========
  "armani": "Armani", "亞曼尼": "Armani", "阿瑪尼": "Armani",
  "versace": "Versace", "凡賽斯": "Versace", "范思哲": "Versace",
  "dolce & gabbana": "Dolce & Gabbana", "d&g": "Dolce & Gabbana", "杜嘉班納": "Dolce & Gabbana",
  "ralph lauren": "Ralph Lauren", "polo": "Ralph Lauren", "拉夫勞倫": "Ralph Lauren",
  "tommy hilfiger": "Tommy Hilfiger", "湯米": "Tommy Hilfiger",
  "calvin klein": "Calvin Klein", "ck": "Calvin Klein", "卡爾文克雷恩": "Calvin Klein",
  "hugo boss": "Hugo Boss", "boss": "Hugo Boss", "波士": "Hugo Boss",
  "lacoste": "Lacoste", "鱷魚牌": "Lacoste",
  "fred perry": "Fred Perry", "月桂葉": "Fred Perry",
  "paul smith": "Paul Smith", "保羅史密斯": "Paul Smith",
  "vivienne westwood": "Vivienne Westwood", "薇薇安魏斯伍德": "Vivienne Westwood", "土星": "Vivienne Westwood",
  
  // ========== 運動服飾品牌 ==========
  "lululemon": "Lululemon", "露露檸檬": "Lululemon",
  "the north face": "The North Face", "tnf": "The North Face", "北臉": "The North Face", "北面": "The North Face",
  "patagonia": "Patagonia", "巴塔哥尼亞": "Patagonia",
  "columbia": "Columbia", "哥倫比亞": "Columbia",
  "mammut": "Mammut", "長毛象": "Mammut",
  "arc'teryx": "Arc'teryx", "arcteryx": "Arc'teryx", "始祖鳥": "Arc'teryx",
  "marmot": "Marmot", "土撥鼠": "Marmot",
  "mountain hardwear": "Mountain Hardwear", "山浩": "Mountain Hardwear",
  
  // ========== 日本品牌 ==========
  "comme des garcons": "Comme des Garçons", "川久保玲": "Comme des Garçons", "cdg": "Comme des Garçons",
  "issey miyake": "Issey Miyake", "三宅一生": "Issey Miyake",
  "yohji yamamoto": "Yohji Yamamoto", "山本耀司": "Yohji Yamamoto",
  "bape": "Bape", "a bathing ape": "Bape", "猿人頭": "Bape",
  "neighborhood": "Neighborhood", "nbhd": "Neighborhood",
  "visvim": "Visvim",
  "porter": "Porter", "吉田包": "Porter",
  
  // ========== 其他常見品牌 ==========
  "levis": "Levi's", "levi's": "Levi's", "李維斯": "Levi's",
  "wrangler": "Wrangler", "牧馬人": "Wrangler",
  "lee": "Lee",
  "diesel": "Diesel", "迪賽": "Diesel",
  "g-star": "G-Star", "gstar": "G-Star",
  "superdry": "Superdry", "極度乾燥": "Superdry",
  "stussy": "Stüssy", "stüssy": "Stüssy", "史圖西": "Stüssy",
  "supreme": "Supreme",
  "palace": "Palace",
  "off-white": "Off-White", "offwhite": "Off-White",
  "stone island": "Stone Island", "石頭島": "Stone Island",
  "cp company": "C.P. Company", "c.p. company": "C.P. Company",
};

function standardizeBrandName(name = "") {
  const k = (name || "").toLowerCase().trim();
  return BRAND_MAP[k] || name;
}

function parseJSONSafe(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/* ---------------- 重試機制 ---------------- */
async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.response?.status === 429 && i < maxRetries - 1) {
        log('RETRY', `Rate limit hit, retrying in ${delay}ms... (attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // 指數退避
      } else {
        throw error;
      }
    }
  }
}

/* ---------------- 圖片驗證 ---------------- */
function validateImage(imageBuffer, maxSize = 20 * 1024 * 1024) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    return { valid: false, error: "圖片格式有誤，請重新上傳 🙏" };
  }
  
  if (imageBuffer.length > maxSize) {
    return { valid: false, error: "圖片檔案過大（超過20MB），請壓縮後再上傳 😊" };
  }
  
  return { valid: true };
}

/* ---------------- 快取工具 ---------------- */
function getCacheKey(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function getCachedResult(key) {
  const cached = brandCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
    log('CACHE', `Cache hit for key: ${key.substring(0, 16)}...`);
    return cached.data;
  }
  return null;
}

function setCachedResult(key, data) {
  brandCache.set(key, {
    data,
    timestamp: Date.now()
  });
  
  // 自動清理過期快取
  setTimeout(() => {
    if (brandCache.has(key)) {
      brandCache.delete(key);
      log('CACHE', `Cache expired for key: ${key.substring(0, 16)}...`);
    }
  }, CACHE_EXPIRY);
}

/* ---------------- 品牌辨識：第二階段補強（看圖＋看文） ---------------- */
async function detectBrandFromImageB64(base64Image) {
  // Mock 模式
  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock brand detection from image');
    return { brand: "Nike", confidence: 85 };
  }

  // 檢查快取
  const cacheKey = getCacheKey(base64Image);
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(async () => {
      const resp = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "你是精品品牌辨識助手。請只回傳 JSON，格式為 {\"brand\":\"品牌英文名或中文名\",\"confidence\":0-100}。若無把握，brand 填 \"無\"、confidence 給 0。"
          },
          {
            role: "user",
            content: [
              { type: "text", text: "請辨識圖片中的品牌（包包、鞋子、衣服都可以）。" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 120
      });
      return resp;
    });

    const raw = result?.choices?.[0]?.message?.content || "";
    const data = parseJSONSafe(raw) || {};
    let brand = standardizeBrandName(String(data.brand || "").trim());
    const conf = Math.max(0, Math.min(100, Number(data.confidence || 0)));
    
    if (!brand || brand.toLowerCase() === "無") {
      setCachedResult(cacheKey, null);
      return null;
    }

    const finalResult = { brand, confidence: conf };
    setCachedResult(cacheKey, finalResult);
    log('BRAND', `Detected brand from image: ${brand} (${conf}%)`);
    
    return finalResult;
  } catch (error) {
    log('ERROR', 'Brand detection from image failed', error.message);
    return null;
  }
}

async function detectBrandFromText(text) {
  // Mock 模式
  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock brand detection from text');
    return { brand: "Adidas", confidence: 75 };
  }

  // 檢查快取
  const cacheKey = getCacheKey(text);
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(async () => {
      const resp = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "從文字中抽取品牌，僅回 JSON：{\"brand\":\"...\",\"confidence\":0-100}；若沒有品牌回 {\"brand\":\"無\",\"confidence\":0}。"
          },
          { role: "user", content: text }
        ],
        temperature: 0,
        max_tokens: 80
      });
      return resp;
    });

    const raw = result?.choices?.[0]?.message?.content || "";
    const data = parseJSONSafe(raw) || {};
    let brand = standardizeBrandName(String(data.brand || "").trim());
    const conf = Math.max(0, Math.min(100, Number(data.confidence || 0)));
    
    if (!brand || brand.toLowerCase() === "無") {
      setCachedResult(cacheKey, null);
      return null;
    }

    const finalResult = { brand, confidence: conf || 60 };
    setCachedResult(cacheKey, finalResult);
    log('BRAND', `Detected brand from text: ${brand} (${conf}%)`);
    
    return finalResult;
  } catch (error) {
    log('ERROR', 'Brand detection from text failed', error.message);
    return null;
  }
}

/* =================== 污漬智能分析（品牌辨識強化） =================== */
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
  log('ANALYZE', 'Starting stain analysis', { 
    hasImage: !!imageBuffer, 
    hasMaterial: !!materialInfo, 
    hasLabel: !!labelImageBuffer 
  });

  // Mock 模式
  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock stain analysis');
    return "【測試模式】這是模擬的污漬分析結果\n\n【分析】\n物品為深色外套，右袖有明顯油性污漬。\n\n【清潔建議】\n建議交給 C.H 精緻洗衣專業處理 💙";
  }

  // 驗證圖片
  const validation = validateImage(imageBuffer);
  if (!validation.valid) {
    log('ERROR', 'Image validation failed', validation.error);
    return validation.error;
  }

  // 驗證標籤圖（如果有）
  if (labelImageBuffer) {
    const labelValidation = validateImage(labelImageBuffer);
    if (!labelValidation.valid) {
      log('WARN', 'Label image validation failed', labelValidation.error);
      labelImageBuffer = null; // 忽略標籤圖，繼續處理
    }
  }

  try {
    const base64Image = imageBuffer.toString("base64");
    const base64Label = labelImageBuffer ? labelImageBuffer.toString("base64") : "";
    
    const userContent = [
      { type: "text", text: "請盡可能詳細分析此物品與污漬，並提供簡短清潔建議。" },
      ...(materialInfo ? [{ type: "text", text: `衣物材質：${materialInfo}` }] : []),
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
    ];
    
    if (base64Label) {
      userContent.push({ type: "text", text: "以下是洗滌標籤，僅供參考：" });
      userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Label}` } });
    }

    // 動態調整 max_tokens
    const maxTokens = base64Label ? 1200 : 1000;

    const resp = await retryWithBackoff(async () => {
      return await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `
你是 C.H 精緻洗衣 的專業清潔顧問，請用口語化繁體中文，結構如下：

【分析】
- 物品與污漬狀況（2–4 句：位置、範圍、顏色、滲入深度）
- 材質特性與注意（縮水/掉色/塗層/皮革護理等）
- 污漬可能來源（油/汗/化妝/墨水/咖啡…）
- 清潔成功機率（可附百分比，但偏保守；用「有機會改善／可望提升外觀」）
- 品牌/年份/款式推測（能推就推，用「可能為／推測為」）
- 結尾：我們會根據材質特性進行適當清潔，確保最佳效果。

【清潔建議】
- 只寫 1–2 句，不提供 DIY 比例，不使用「保證／一定」字眼
- 可說「若擔心，建議交給 C.H 精緻洗衣專業處理，避免自行操作造成二次損傷 💙」
`.trim(),
          },
          { role: "user", content: userContent },
        ],
        temperature: 0.6,
        max_tokens: maxTokens,
      });
    });

    let out = resp?.choices?.[0]?.message?.content || "建議交給 C.H 精緻洗衣評估與處理喔 😊";
    out = out.replace(/\*\*/g, "");
    out = reducePercentages(out, 5);
    
    if (!/我們會根據材質特性進行適當清潔，確保最佳效果。/.test(out)) {
      out += `\n我們會根據材質特性進行適當清潔，確保最佳效果。`;
    }
