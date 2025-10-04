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
const LINE_PAY_URL = process.env.LINE_PAY_URL || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL = process.env.ECPAY_URL || "https://p.ecpay.com.tw/55FFE71";
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
  "lv": "Louis Vuitton", "louis vuitton": "Louis Vuitton", "路易威登": "Louis Vuitton",
  "chanel": "Chanel", "香奈兒": "Chanel",
  "gucci": "Gucci", "古馳": "Gucci",
  "dior": "Dior", "迪奧": "Dior",
  "hermes": "Hermès", "hèrmes": "Hermès", "愛馬仕": "Hermès",
  "prada": "Prada", "普拉達": "Prada",
  "coach": "Coach", "蔻馳": "Coach",
  "balenciaga": "Balenciaga", "巴黎世家": "Balenciaga",
  "goyard": "Goyard", "戈雅": "Goyard",
  "miu miu": "Miu Miu", "miumiu": "Miu Miu",
  "celine": "Celine", "思琳": "Celine",
  "ysl": "Saint Laurent", "saint laurent": "Saint Laurent", "聖羅蘭": "Saint Laurent",
  "burberry": "Burberry", "巴寶莉": "Burberry",
  // 新增品牌
  "fendi": "Fendi", "芬迪": "Fendi",
  "bottega veneta": "Bottega Veneta", "bv": "Bottega Veneta", "寶緹嘉": "Bottega Veneta",
  "loewe": "Loewe", "羅意威": "Loewe",
  "givenchy": "Givenchy", "紀梵希": "Givenchy",
  "valentino": "Valentino", "華倫天奴": "Valentino",
  "mcm": "MCM",
  "longchamp": "Longchamp", "瓏驤": "Longchamp",
  "michael kors": "Michael Kors", "mk": "Michael Kors",
  "kate spade": "Kate Spade",
  "tory burch": "Tory Burch",
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
    return { brand: "Louis Vuitton", confidence: 85 };
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
              { type: "text", text: "請辨識圖片中的品牌。" },
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
    return { brand: "Gucci", confidence: 75 };
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

    // 品牌辨識補強（先看圖，再看文，取信心較高者）
    let best = await detectBrandFromImageB64(base64Image);
    if (!best) best = await detectBrandFromText(out);
    
    if (best && best.brand && !out.includes("品牌可能為")) {
      const conf = Math.round(Math.max(0, Math.min(100, best.confidence)));
      out = `🔍 品牌可能為：${best.brand}（信心約 ${conf}%）\n\n${out}`;
      log('ANALYZE', `Brand added to analysis: ${best.brand}`);
    }

    log('ANALYZE', 'Stain analysis completed successfully');
    return out;
    
  } catch (e) {
    log('ERROR', 'Stain analysis failed', e.message);
    console.error("[智能污漬分析錯誤]", e);
    return "抱歉，目前分析系統忙碌中，請稍後再試 🙏";
  }
}

/* ---------------- 固定模板（品項類回覆更自然） ---------------- */
// 包包
const TPL_BAG = [
  "您好，包包我們有專業處理 💼 會依材質調整方式，像皮革會注意保養護理，布面則加強清潔與定型，請您放心交給 C.H 精緻洗衣 😊",
  "包包是可以處理的 👍 我們會先檢視材質狀況，盡量在清潔同時保護原有外觀，有需要也能加強整形或護理 💙",
  "可以的喔 💼 包包清潔會依布料或皮革狀況分別處理，細節我們都會把關 ✨",
];

// 鞋子
const TPL_SHOE = [
  "可以清潔鞋子，我們會依材質（布面/皮革/麂皮）調整方式，盡量恢復外觀 👟",
  "鞋子可處理；發霉、異味或黃斑多能改善，會先做不顯眼處測試再進行 😊",
  "可清潔；皮革鞋會注意上油護理，布面鞋會加強清潔與定型 💙",
  "可以清洗；鞋底與縫線易藏污，我們會細清與除味，穿著感更好 ✨",
];

// 窗簾
const TPL_CURTAIN = [
  "可以清潔窗簾，我們會依布料與織法調整流程，兼顧潔淨與版型 👌",
  "窗簾可處理；會先評估縮水與掉色風險，再安排合適方式 😊",
  "可清潔；若有特殊塗層會先做小範圍測試，處理後更清爽 💙",
  "窗簾可以清洗，會注意尺寸穩定與垂墜感，完成後更俐落 ✨",
];

// 地毯
const TPL_RUG = [
  "地毯可以清潔，我們會分區與深層清潔，兼顧纖維與色澤，整體觀感可望提升 ✨",
  "地毯可處理；會先做局部測試再進行深層清潔與除味，讓居家更清爽 😊",
  "可以清潔地毯；針對藏汙位置與邊緣收邊會特別留意，完成後更舒適 👍",
];

// 棉被/被子
const TPL_QUILT = [
  "棉被可以清潔；我們會兼顧蓬鬆度與乾爽度，睡感可望更舒適 😊",
  "被子可處理；流程會保護纖維結構並充分烘透，使用上更衛生 💙",
  "可以清洗棉被；完成後會更乾淨清新，收納也更安心 ✨",
];

/* =================== 智能客服回覆 =================== */
async function smartAutoReply(inputText) {
  if (!inputText) return null;
  
  log('REPLY', `收到訊息: ${inputText.substring(0, 100)}${inputText.length > 100 ? '...' : ''}`);
  
  const text = normalize(inputText);
  if (isEmojiOrPuncOnly(text)) {
    log('REPLY', '訊息僅包含表情符號或標點，跳過回覆');
    return null;
  }
  
  if (!maybeLaundryRelated(text)) {
    log('REPLY', '訊息與洗衣無關，跳過回覆');
    return null;
  }

  let reply = null;

  // 送洗/收件
  if (/(送洗|我要送洗|想送洗衣服|我想送洗|我想洗衣服)/.test(text)) {
    if (isSaturday()) {
      reply = "今天週六固定公休，明日週日有營業的，我們會去收回喔 😊";
    } else {
      reply = "好的 😊 沒問題，我們會過去收回的";
    }
  }
  else if (/(收衣|收件|來收|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    if (isSaturday()) {
      reply = addr
        ? `今天週六固定公休，明日週日有營業的，我們會去收回喔 😊 地址是：${addr}`
        : "今天週六固定公休，明日週日有營業的，我們會去收回喔 😊";
    } else {
      reply = addr ? `好的 😊 我們會去收回，地址是：${addr}` : "好的 😊 我們會去收回的";
    }
  }
  // 付款
  else if (/(付款|結帳|支付|刷卡|line ?pay|信用卡|匯款)/i.test(text)) {
    reply = (
      "以下提供兩種付款方式，您可以依方便選擇：\n\n" +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      "感謝您的支持與配合 💙"
    );
  }
  // 優惠 / 活動
  else if (/(優惠|活動|折扣|促銷|特價|有沒有.*活動)/.test(text)) {
    reply = "您好，我們的優惠活動會不定期在官方網站及社群媒體上發布，建議您可以追蹤我們的社群平台以免錯過任何好康資訊。";
  }
  // 清潔時間（7–10 天）
  else if (/(多久|幾天|時間|要多久)/.test(text)) {
    reply = pick([
      "一般清潔作業時間約 7–10 天 ⏳",
      "通常 7–10 天可完成，如遇特殊材質會另行告知，謝謝您 🙏",
      "作業期程多為 7–10 天，若需加速也可再跟我們說明需求 😊",
    ]);
  }
  // 營業時間 / 是否有開（週六固定公休）
  else if (/(幾點開|幾點關|營業|開門|關門|打烊|今天有開|今日有開|有沒有開)/.test(text)) {
    if (BUSINESS_HOURS_TEXT_ENV) {
      reply = BUSINESS_HOURS_TEXT_ENV;
    } else if (isSaturday()) {
      reply = "今天是週六固定公休，明日週日有營業的 😊";
    } else {
      reply = "營業時間：週一至週日 10:30–20:00（週六公休）。如需到府收件可跟我們說喔，謝謝您 😊";
    }
  }
  // 進度查詢
  else if (/(洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(text)) {
    reply = `您可以這邊線上查詢 C.H精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間會有專人回覆，謝謝您 🙏`;
  }
  // 一起洗
  else if (/一起洗|一起處理|全部洗/.test(text)) {
    reply = "可以的 😊 請放心交給 C.H 精緻洗衣 💙";
  }
  // 棉被 / 羽絨被
  else if (/(棉被|被子|羽絨被)/.test(text)) {
    if (/怕|擔心|壓壞|羽絨/.test(text)) {
      reply = "不會的 🪶 我們會注意保護羽絨結構，讓它保持蓬鬆度 ✨";
    } else {
      reply = "可以的 😊 我們會兼顧蓬鬆度與乾爽度，處理後會更舒適 💙";
    }
  }
  // 鞋子（含擔心出意外）
  else if (/(鞋子|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text) || /(有.*洗.*鞋|有洗鞋|鞋(子)?可以洗|洗鞋(服務)?)/i.test(text)) {
    if (/不要再出意外|小心|上次|擔心|希望.*不要再出意外/.test(text)) {
      reply = "沒問題 👟 我們會額外留意細節，請您特別放心 💙";
    } else {
      reply = "可以的 👟 我們會特別注意的，請放心交給 C.H 精緻洗衣 💙";
    }
  }
  // 嬰幼兒用品（汽座/手推車/嬰兒車）→ 按 2
  else if (/(手推車|推車|嬰兒車|汽座|安全座椅)/.test(text)) {
    reply = pick([
      "可以清潔；細節較多，若需完整報價與時程，請按 2 由專人協助您 😊",
      "我們能處理這類品項；想了解流程與注意事項，請按 2，謝謝您 💙",
      "可處理沒問題；如需更詳細說明，請按 2 讓專人與您聯繫 🙏",
    ]);
  }
  // 包包
  else if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    reply = pick(TPL_BAG);
  }
  // 地毯
  else if (/(地毯|地墊)/.test(text)) {
    reply = pick(TPL_RUG);
  }
  // 帽子
  else if (/(帽子|毛帽|棒球帽|鴨舌帽|禮帽)/.test(text)) {
    reply = pick([
      "可以清潔帽子，我們會依材質（棉/毛料/皮革/混紡）調整方式，並留意帽型不變形 😊",
      "帽子可處理；會先做小範圍測試再清潔，兼顧外觀與版型 ✨",
      "可以洗的；我們會針對汗線與邊緣髒汙分區處理，盡量提升整體觀感 💙",
    ]);
  }
  // 窗簾
  else if (/(窗簾|布簾|遮光簾)/.test(text)) {
    reply = pick(TPL_CURTAIN);
  }
  // 污漬/泛黃/染色/縮水（不給保證）
  else if (/(污漬|髒污|泛黃|黃斑|染色|掉色|縮水|變形)/.test(text)) {
    reply = pick([
      "這些情況我們可以處理；會依狀況調整方式，有機會改善外觀與清新度 😊",
      "可處理；不同成因會採取不同方法，但改善幅度需視程度而定，我們會如實說明 💙",
      "我們會盡量處理；舊氧化或嚴重染色效果會較保守，會先做小面積測試 ✨",
      "可以處理；會先評估安全性再進行，降低對材質的負擔 👍",
    ]);
  }
  // 一般衣物能不能洗
  else if (/(可以洗|能不能洗|可不可以洗|能洗|可清洗|能處理|可處理)/.test(text) &&
      /(衣|外套|羽絨|襯衫|大衣|褲)/.test(text)) {
    reply = pick([
      "可以清洗，多數衣物都沒問題；會依材質調整流程並說明預期改善幅度 😊",
      "可清潔；細節會於現場再確認，過程會盡量保護纖維結構 💙",
      "可以處理；會先做材質測試與局部處理，再決定整體流程，降低風險 ✨",
    ]);
  }

  // —— Fallback（仍屬洗衣主題，使用 AI） ——
  if (!reply) {
    // Mock 模式
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
                content: "你是「C.H 精緻洗衣」客服。用自然口語繁中、禮貌專業、避免絕對保證；1～3 句即可，語氣多樣、別重複。" 
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
          reply = "我們已收到您的訊息，會再與您確認細節，謝謝您 😊";
        }
        
        // 移除保證性用語
        reply = reply
          .replace(/保證|一定|絕對/gi, "")
          .replace(/請放心交給.*?精緻洗衣/g, "我們會妥善處理與說明，謝謝您");
        
        log('REPLY', 'AI fallback reply generated');
      } catch (e) {
        log('ERROR', 'AI reply generation failed', e.message);
        console.error("[AI 回覆錯誤]", e);
        reply = "抱歉，目前系統忙碌中 🙏";
      }
    }
  }

  if (reply) {
    log('REPLY', `回覆內容: ${reply.substring(0, 100)}${reply.length > 100 ? '...' : ''}`);
  }

  return reply;
}

/* =================== 導出模組 =================== */
module.exports = { 
  analyzeStainWithAI, 
  smartAutoReply,
  // 新增：導出工具函數供測試使用
  validateImage,
  extractTWAddress,
  standardizeBrandName,
  isSaturday,
  // 新增：導出快取管理函數
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
