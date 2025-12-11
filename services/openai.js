// services/openai.js
const { OpenAI } = require("openai");
const crypto = require('crypto');

// ============ 環境變數檢查 ============
if (!process.env.OPENAI_API_KEY) {
  throw new Error("❌ 缺少 OPENAI_API_KEY 環境變數");
}

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 固定連結(移除 LINE PAY 與 ECPAY 固定連結)
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

const isSaturday = () => {
  const now = new Date();
  const taiwanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanTime.getDay() === 6;
};

/* ---------------- 品牌名稱標準化與 JSON 安全解析 ---------------- */
const BRAND_MAP = {
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
  "lululemon": "Lululemon", "露露檸檬": "Lululemon",
  "the north face": "The North Face", "tnf": "The North Face", "北臉": "The North Face", "北面": "The North Face",
  "patagonia": "Patagonia", "巴塔哥尼亞": "Patagonia",
  "columbia": "Columbia", "哥倫比亞": "Columbia",
  "mammut": "Mammut", "長毛象": "Mammut",
  "arc'teryx": "Arc'teryx", "arcteryx": "Arc'teryx", "始祖鳥": "Arc'teryx",
  "marmot": "Marmot", "土撥鼠": "Marmot",
  "mountain hardwear": "Mountain Hardwear", "山浩": "Mountain Hardwear",
  "comme des garcons": "Comme des Garçons", "川久保玲": "Comme des Garçons", "cdg": "Comme des Garçons",
  "issey miyake": "Issey Miyake", "三宅一生": "Issey Miyake",
  "yohji yamamoto": "Yohji Yamamoto", "山本耀司": "Yohji Yamamoto",
  "bape": "Bape", "a bathing ape": "Bape", "猿人頭": "Bape",
  "neighborhood": "Neighborhood", "nbhd": "Neighborhood",
  "visvim": "Visvim",
  "porter": "Porter", "吉田包": "Porter",
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
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}

/* ---------------- 圖片驗證 ---------------- */
function validateImage(imageBuffer, maxSize = 20 * 1024 * 1024) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    return { valid: false, error: "圖片格式有誤,請重新上傳 🙏" };
  }
  
  if (imageBuffer.length > maxSize) {
    return { valid: false, error: "圖片檔案過大(超過20MB),請壓縮後再上傳 😊" };
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
  
  setTimeout(() => {
    if (brandCache.has(key)) {
      brandCache.delete(key);
      log('CACHE', `Cache expired for key: ${key.substring(0, 16)}...`);
    }
  }, CACHE_EXPIRY);
}

/* ---------------- 品牌辨識 ---------------- */
async function detectBrandFromImageB64(base64Image) {
  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock brand detection from image');
    return { brand: "Nike", confidence: 85 };
  }

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
              "你是精品品牌辨識助手。請只回傳 JSON,格式為 {\"brand\":\"品牌英文名或中文名\",\"confidence\":0-100}。若無把握,brand 填 \"無\"、confidence 給 0。"
          },
          {
            role: "user",
            content: [
              { type: "text", text: "請辨識圖片中的品牌(包包、鞋子、衣服都可以)。" },
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
  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock brand detection from text');
    return { brand: "Adidas", confidence: 75 };
  }

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
              "從文字中抽取品牌,僅回 JSON:{\"brand\":\"...\",\"confidence\":0-100};若沒有品牌回 {\"brand\":\"無\",\"confidence\":0}。"
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

/* =================== 污漬智能分析 =================== */
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
  log('ANALYZE', 'Starting stain analysis', { 
    hasImage: !!imageBuffer, 
    hasMaterial: !!materialInfo, 
    hasLabel: !!labelImageBuffer 
  });

  if (IS_DEVELOPMENT && USE_MOCK) {
    log('MOCK', 'Using mock stain analysis');
    return "【測試模式】這是模擬的污漬分析結果\n\n【分析】\n物品為深色外套,右袖有明顯油性污漬。\n\n【清潔建議】\n建議交給 C.H 精緻洗衣專業處理 💙";
  }

  const validation = validateImage(imageBuffer);
  if (!validation.valid) {
    log('ERROR', 'Image validation failed', validation.error);
    return validation.error;
  }

  if (labelImageBuffer) {
    const labelValidation = validateImage(labelImageBuffer);
    if (!labelValidation.valid) {
      log('WARN', 'Label image validation failed', labelValidation.error);
      labelImageBuffer = null;
    }
  }

  try {
    const base64Image = imageBuffer.toString("base64");
    const base64Label = labelImageBuffer ? labelImageBuffer.toString("base64") : "";
    
    const userContent = [
      { type: "text", text: "請盡可能詳細分析此物品與污漬,並提供簡短清潔建議。" },
      ...(materialInfo ? [{ type: "text", text: `衣物材質:${materialInfo}` }] : []),
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
    ];
    
    if (base64Label) {
      userContent.push({ type: "text", text: "以下是洗滌標籤,僅供參考:" });
      userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Label}` } });
    }

    const maxTokens = base64Label ? 1200 : 1000;

    const resp = await retryWithBackoff(async () => {
      return await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `
你是 C.H 精緻洗衣的專業清潔顧問,請用口語化繁體中文分析。

**分析步驟:**
1. 首先判斷物品類型(包包/鞋子/衣服/其他)
2. 識別品牌(參考已知品牌列表)
3. 分析污漬種類與嚴重程度
4. 評估清洗成功率
5. 給出專業建議

**回覆格式:**

📦 物品類型:[包包/鞋子/衣服/其他]
🏷️ 品牌:[品牌名稱或"無法確定"]

【分析】
- 物品與污漬狀況(2–4 句:位置、範圍、顏色、滲入深度)
- 材質特性與注意(縮水/掉色/塗層/皮革護理等)
- 污漬可能來源(油/汗/化妝/墨水/咖啡…)
- 清潔成功機率(可附百分比,但偏保守;用「有機會改善/可望提升外觀」)
- 結尾:我們會根據材質特性進行適當清潔,確保最佳效果。

【清潔建議】
- 只寫 1–2 句,不提供 DIY 比例,不使用「保證/一定」字眼
- 可說「若擔心,建議交給 C.H 精緻洗衣專業處理,避免自行操作造成二次損傷 💙」

**注意事項:**
- 包包:特別注意皮革/帆布材質差異
- 鞋子:留意鞋底/鞋面材質與清潔方式
- 衣服:分析布料種類與染色風險
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
    
    if (!/我們會根據材質特性進行適當清潔,確保最佳效果。/.test(out)) {
      out += `\n我們會根據材質特性進行適當清潔,確保最佳效果。`;
    }

    // ✅ 修正:如果 AI 沒有識別出品牌,嘗試用品牌辨識
    if (!out.includes("🏷️ 品牌:")) {
      let best = await detectBrandFromImageB64(base64Image);
      if (!best) best = await detectBrandFromText(out);
      
      if (best && best.brand) {
        const conf = Math.round(Math.max(0, Math.min(100, best.confidence)));
        const lines = out.split('\n');
        if (lines[0] && lines[0].includes('📦 物品類型:')) {
          lines.splice(1, 0, `🏷️ 品牌:${best.brand}(信心約 ${conf}%)`);
          out = lines.join('\n');
        } else {
          out = `🏷️ 品牌:${best.brand}(信心約 ${conf}%)\n\n${out}`;
        }
        log('ANALYZE', `Brand added to analysis: ${best.brand}`);
      }
    } else if (out.includes("無法確定")) {
      let best = await detectBrandFromImageB64(base64Image);
      if (!best) best = await detectBrandFromText(out);
      
      if (best && best.brand) {
        const conf = Math.round(Math.max(0, Math.min(100, best.confidence)));
        out = out.replace(/🏷️ 品牌:.*?無法確定.*?\n/, `🏷️ 品牌:${best.brand}(信心約 ${conf}%)\n`);
        log('ANALYZE', `Brand updated in analysis: ${best.brand}`);
      }
    }

    log('ANALYZE', 'Stain analysis completed successfully');
    return out;
    
  } catch (e) {
    log('ERROR', 'Stain analysis failed', e.message);
    console.error("[智能污漬分析錯誤]", e);
    return "抱歉,目前分析系統忙碌中,請稍後再試 🙏";
  }
}

/* ---------------- 固定模板 ---------------- */
const TPL_BAG = [
  "您好,包包我們有專業處理 💼 會依材質調整方式,像皮革會注意保養護理,布面則加強清潔與定型,請您放心交給 C.H 精緻洗衣 😊",
  "包包是可以處理的 👍 我們會先檢視材質狀況,盡量在清潔同時保護原有外觀,有需要也能加強整形或護理 💙",
  "可以的喔 💼 包包清潔會依布料或皮革狀況分別處理,細節我們都會把關 ✨",
];

const TPL_SHOE = [
  "可以清潔鞋子,我們會依材質(布面/皮革/麂皮)調整方式,盡量恢復外觀 👟",
  "鞋子可處理;發霉、異味或黃斑多能改善,會先做不顯眼處測試再進行 😊",
  "可清潔;皮革鞋會注意上油護理,布面鞋會加強清潔與定型 💙",
  "可以清洗;鞋底與縫線易藏污,我們會細清與除味,穿著感更好 ✨",
];

const TPL_CURTAIN = [
  "可以清潔窗簾,我們會依布料與織法調整流程,兼顧潔淨與版型 👌",
  "窗簾可處理;會先評估縮水與掉色風險,再安排合適方式 😊",
  "可清潔;若有特殊塗層會先做小範圍測試,處理後更清爽 💙",
  "窗簾可以清洗,會注意尺寸穩定與垂墜感,完成後更俐落 ✨",
];

const TPL_RUG = [
  "地毯可以清潔,我們會分區與深層清潔,兼顧纖維與色澤,整體觀感可望提升 ✨",
  "地毯可處理;會先做局部測試再進行深層清潔與除味,讓居家更清爽 😊",
  "可以清潔地毯;針對藏汙位置與邊緣收邊會特別留意,完成後更舒適 👍",
];

const TPL_QUILT = [
  "棉被可以清潔;我們會兼顧蓬鬆度與乾爽度,睡感可望更舒適 😊",
  "被子可處理;流程會保護纖維結構並充分烘透,使用上更衛生 💙",
  "可以清洗棉被;完成後會更乾淨清新,收納也更安心 ✨",
];

/* =================== 智能客服回覆 =================== */
async function smartAutoReply(inputText) {
  if (!inputText) return null;
  
  log('REPLY', `收到訊息: ${inputText.substring(0, 100)}${inputText.length > 100 ? '...' : ''}`);
  
  const text = normalize(inputText);
  if (isEmojiOrPuncOnly(text)) {
    log('REPLY', '訊息僅包含表情符號或標點,跳過回覆');
    return null;
  }
  
  if (!maybeLaundryRelated(text)) {
    log('REPLY', '訊息與洗衣無關,跳過回覆');
    return null;
  }

  let reply = null;

  if (/(送洗|我要送洗|想送洗衣服|我想送洗|我想洗衣服)/.test(text)) {
    if (isSaturday()) {
      reply = "今天週六固定公休,明日週日有營業的,我們會去收回喔 😊";
    } else {
      reply = "好的 😊 沒問題,我們會過去收回的";
    }
  }
  else if (/(收衣|收件|來收|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    if (isSaturday()) {
      reply = addr
        ? `今天週六固定公休,明日週日有營業的,我們會去收回喔 😊 地址是:${addr}`
        : "今天週六固定公休,明日週日有營業的,我們會去收回喔 😊";
    } else {
      reply = addr ? `好的 😊 我們會去收回,地址是:${addr}` : "好的 😊 我們會去收回的";
    }
  }
  else if (/(優惠|活動|折扣|促銷|特價|有沒有.*活動)/.test(text)) {
    reply = "您好,我們的優惠活動會不定期在官方網站及社群媒體上發布,建議您可以追蹤我們的社群平台以免錯過任何好康資訊。";
  }
  else if (/(多久|幾天|時間|要多久)/.test(text)) {
    reply = pick([
      "一般清潔作業時間約 7–10 天 ⏳",
      "通常 7–10 天可完成,如遇特殊材質會另行告知,謝謝您 🙏",
      "作業期程多為 7–10 天,若需加速也可再跟我們說明需求 😊",
    ]);
  }
  else if (/(幾點開|幾點關|營業|開門|關門|打烊|今天有開|今日有開|有沒有開)/.test(text)) {
    if (BUSINESS_HOURS_TEXT_ENV) {
      reply = BUSINESS_HOURS_TEXT_ENV;
    } else if (isSaturday()) {
      reply = "今天是週六固定公休,明日週日有營業的 😊";
    } else {
      reply = "營業時間:週一至週日 10:30–20:00(週六公休)。如需到府收件可跟我們說喔,謝謝您 😊";
    }
  }
  else if (/(洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(text)) {
    reply = `您可以這邊線上查詢 C.H精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間會有專人回覆,謝謝您 🙏`;
  }
  else if (/一起洗|一起處理|全部洗/.test(text)) {
    reply = "可以的 😊 請放心交給 C.H 精緻洗衣 💙";
  }
  else if (/(棉被|被子|羽絨被)/.test(text)) {
    if (/怕|擔心|壓壞|羽絨/.test(text)) {
      reply = "不會的 🪶 我們會注意保護羽絨結構,讓它保持蓬鬆度 ✨";
    } else {
      reply = "可以的 😊 我們會兼顧蓬鬆度與乾爽度,處理後會更舒適 💙";
    }
  }
  else if (/(鞋子|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text) || /(有.*洗.*鞋|有洗鞋|鞋(子)?可以洗|洗鞋(服務)?)/i.test(text)) {
    if (/不要再出意外|小心|上次|擔心|希望.*不要再出意外/.test(text)) {
      reply = "沒問題 👟 我們會額外留意細節,請您特別放心 💙";
    } else {
      reply = "可以的 👟 我們會特別注意的,請放心交給 C.H 精緻洗衣 💙";
    }
  }
  else if (/(手推車|推車|嬰兒車|汽座|安全座椅)/.test(text)) {
    reply = pick([
      "可以清潔;細節較多,若需完整報價與時程,請按 2 由專人協助您 😊",
      "我們能處理這類品項;想了解流程與注意事項,請按 2,謝謝您 💙",
      "可處理沒問題;如需更詳細說明,請按 2 讓專人與您聯繫 🙏",
    ]);
  }
  else if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    reply = pick(TPL_BAG);
  }
  else if (/(地毯|地墊)/.test(text)) {
    reply = pick(TPL_RUG);
  }
  else if (/(帽子|毛帽|棒球帽|鴨舌帽|禮帽)/.test(text)) {
    reply = pick([
      "可以清潔帽子,我們會依材質(棉/毛料/皮革/混紡)調整方式,並留意帽型不變形 😊",
      "帽子可處理;會先做小範圍測試再清潔,兼顧外觀與版型 ✨",
      "可以洗的;我們會針對汗線與邊緣髒汙分區處理,盡量提升整體觀感 💙",
    ]);
  }
  else if (/(窗簾|布簾|遮光簾)/.test(text)) {
    reply = pick(TPL_CURTAIN);
  }
  else if (/(污漬|髒污|泛黃|黃斑|染色|掉色|縮水|變形)/.test(text)) {
    reply = pick([
      "這些情況我們可以處理;會依狀況調整方式,有機會改善外觀與清新度 😊",
      "可處理;不同成因會採取不同方法,但改善幅度需視程度而定,我們會如實說明 💙",
      "我們會盡量處理;舊氧化或嚴重染色效果會較保守,會先做小面積測試 ✨",
      "可以處理;會先評估安全性再進行,降低對材質的負擔 👍",
    ]);
  }
  else if (/(可以洗|能不能洗|可不可以洗|能洗|可清洗|能處理|可處理)/.test(text) &&
      /(衣|外套|羽絨|襯衫|大衣|褲)/.test(text)) {
    reply = pick([
      "可以清洗,多數衣物都沒問題;會依材質調整流程並說明預期改善幅度 😊",
      "可清潔;細節會於現場再確認,過程會盡量保護纖維結構 💙",
      "可以處理;會先做材質測試與局部處理,再決定整體流程,降低風險 ✨",
    ]);
  }

  if (!reply) {
    if (IS_DEVELOPMENT && USE_MOCK) {
      log('MOCK', 'Using mock AI reply');
      reply = "【測試模式】這是模擬的 AI 客服回覆 😊";
    } else {
      try {
        const aiReply = await retryWithBackoff(async () => {
          const resp = await openaiClient.chat.completions.create({
            model: "gpt-4",
            messages: [
              { 
                role: "system", 
                content: "你是「C.H 精緻洗衣」客服。用自然口語繁中、禮貌專業、避免絕對保證;1～3 句即可,語氣多樣、別重複。" 
              },
              { role: "user", content: text },
            ],
            temperature: 0.85,
            max_tokens: 220,
          });
          return resp;
        });

        reply = aiReply?.choices?.[0]?.message?.content?.trim();
        
        if (!reply) {
          reply = "我們已收到您的訊息,會再與您確認細節,謝謝您 😊";
        }
        
        reply = reply
          .replace(/保證|一定|絕對/gi, "")
          .replace(/請放心交給.*?精緻洗衣/g, "我們會妥善處理與說明,謝謝您");
        
        log('REPLY', 'AI fallback reply generated');
      } catch (e) {
        log('ERROR', 'AI reply generation failed', e.message);
        console.error("[AI 回覆錯誤]", e);
        reply = "抱歉,目前系統忙碌中 🙏";
      }
    }
  }

  if (reply) {
    log('REPLY', `回覆內容: ${reply.substring(0, 100)}${reply.length > 100 ? '...' : ''}`);
  }

  return reply;
}

/* =================== 綠界付款功能(修正版)=================== */
function createECPayPaymentLink(userId, userName, amount) {
  const { ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV, RAILWAY_STATIC_URL } = process.env;

  if (!ECPAY_MERCHANT_ID || !ECPAY_HASH_KEY || !ECPAY_HASH_IV) {
    log('ERROR', '缺少綠界環境變數');
    throw new Error('綠界環境變數未設定');
  }

  let baseURL = RAILWAY_STATIC_URL || 'https://stain-bot-production-2593.up.railway.app';
  if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
    baseURL = `https://${baseURL}`;
  }
  
  const merchantTradeNo = `CH${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  const now = new Date();
  const tradeDate = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const paymentData = {
    MerchantID: ECPAY_MERCHANT_ID,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: 'CH精緻洗衣服務',
    ItemName: '洗衣服務費用',
    ReturnURL: `${baseURL}/payment/ecpay/callback`,
    ClientBackURL: `${baseURL}/payment/success`,
    // 🔴 新增這三個，避免跳出返回造成容易失效、並延長有效時間（分鐘）
    ExpireDate: '1440', // 24 小時（分鐘）
    OrderResultURL: `${baseURL}/payment/success`,
    ClientRedirectURL: `${baseURL}/payment/success`,

    // 付款方式可留 ALL，或你固定用信用卡可設 'Credit'
    ChoosePayment: 'ALL',
    EncryptType: 1,
    CustomField1: userId,
    CustomField2: userName
  };

  try {
    paymentData.CheckMacValue = generateECPayCheckMacValue(paymentData);
    const paymentLink = `${baseURL}/payment/redirect?data=${encodeURIComponent(Buffer.from(JSON.stringify(paymentData)).toString('base64'))}`;
    log('PAYMENT', `綠界連結已生成: 訂單=${merchantTradeNo}, 金額=${amount}元, 客戶=${userName}`);
    return paymentLink;
  } catch (error) {
    log('ERROR', '生成付款連結失敗', error.message);
    throw error;
  }
}

function generateECPayCheckMacValue(params) {
  const { ECPAY_HASH_KEY, ECPAY_HASH_IV } = process.env;
  const data = { ...params };
  delete data.CheckMacValue;

  const sortedKeys = Object.keys(data).sort();
  let checkString = `HashKey=${ECPAY_HASH_KEY}`;
  sortedKeys.forEach(key => {
    checkString += `&${key}=${data[key]}`;
  });
  checkString += `&HashIV=${ECPAY_HASH_IV}`;

  checkString = encodeURIComponent(checkString)
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .toLowerCase();

  return crypto.createHash('sha256').update(checkString).digest('hex').toUpperCase();
}


/* =================== 導出模組 =================== */
module.exports = { 
  analyzeStainWithAI, 
  smartAutoReply,
  createECPayPaymentLink,
  validateImage,
  extractTWAddress,
  standardizeBrandName,
  isSaturday,
  getCacheStats: () => ({
    size: brandCache.size,
    keys: Array.from(brandCache.keys()).map(k => k.substring(0, 16) + '...')
  }),
  clearCache: () => {
    const size = brandCache.size;
    brandCache.clear();
    log('CACHE', `Cleared ${size} cache entries`);
    return size;
  }
};
        
