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

/* ---------------- 品牌名稱標準化 ---------------- */
const BRAND_MAP = {
  "lv": "Louis Vuitton", "louis vuitton": "Louis Vuitton", "路易威登": "Louis Vuitton",
  "chanel": "Chanel", "香奈兒": "Chanel",
  "gucci": "Gucci", "古馳": "Gucci",
  "hermes": "Hermès", "愛馬仕": "Hermès",
  "prada": "Prada", "普拉達": "Prada",
  "dior": "Dior", "迪奧": "Dior",
  "nike": "Nike", "耐吉": "Nike",
  "adidas": "Adidas", "愛迪達": "Adidas",
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
        log('RETRY', `Rate limit hit, retrying in ${delay}ms...`);
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
    return cached.data;
  }
  return null;
}

function setCachedResult(key, data) {
  brandCache.set(key, { data, timestamp: Date.now() });
  setTimeout(() => {
    if (brandCache.has(key)) brandCache.delete(key);
  }, CACHE_EXPIRY);
}

/* ---------------- 品牌辨識 ---------------- */
async function detectBrandFromImageB64(base64Image) {
  if (IS_DEVELOPMENT && USE_MOCK) {
    return { brand: "Nike", confidence: 85 };
  }
  const cacheKey = getCacheKey(base64Image);
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(async () => {
      return await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "你是精品品牌辨識助手。請只回傳 JSON，格式為 {\"brand\":\"品牌名\",\"confidence\":0-100}。" },
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
    return finalResult;
  } catch (error) {
    log('ERROR', 'Brand detection failed', error.message);
    return null;
  }
}

async function detectBrandFromText(text) {
  if (IS_DEVELOPMENT && USE_MOCK) {
    return { brand: "Adidas", confidence: 75 };
  }
  const cacheKey = getCacheKey(text);
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(async () => {
      return await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "從文字中抽取品牌，僅回 JSON：{\"brand\":\"...\",\"confidence\":0-100}。" },
          { role: "user", content: text }
        ],
        temperature: 0,
        max_tokens: 80
      });
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
    return finalResult;
  } catch (error) {
    log('ERROR', 'Text brand detection failed', error.message);
    return null;
  }
}

/* =================== 污漬智能分析 =================== */
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
  if (IS_DEVELOPMENT && USE_MOCK) {
    return "【測試模式】模擬污漬分析結果";
  }

  const validation = validateImage(imageBuffer);
  if (!validation.valid) return validation.error;

  if (labelImageBuffer) {
    const labelValidation = validateImage(labelImageBuffer);
    if (!labelValidation.valid) labelImageBuffer = null;
  }

  try {
    const base64Image = imageBuffer.toString("base64");
    const base64Label = labelImageBuffer ? labelImageBuffer.toString("base64") : "";
    
    const userContent = [
      { type: "text", text: "請分析此物品與污漬，並提供清潔建議。" },
      ...(materialInfo ? [{ type: "text", text: `材質：${materialInfo}` }] : []),
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
    ];
    
    if (base64Label) {
      userContent.push({ type: "text", text: "洗滌標籤：" });
      userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Label}` } });
    }

    const resp = await retryWithBackoff(async () => {
      return await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "你是 C.H 精緻洗衣 的專業清潔顧問，用口語化繁中回覆，包含【分析】和【清潔建議】。"
          },
          { role: "user", content: userContent }
        ],
        temperature: 0.6,
        max_tokens: 1000
      });
    });

    let out = resp?.choices?.[0]?.message?.content || "建議交給 C.H 精緻洗衣處理 😊";
    out = out.replace(/\*\*/g, "");
    out = reducePercentages(out, 5);

    let best = await detectBrandFromImageB64(base64Image);
    if (!best) best = await detectBrandFromText(out);
    
    if (best && best.brand && !out.includes("品牌")) {
      out = `🔍 品牌可能為：${best.brand}（${best.confidence}%）\n\n${out}`;
    }

    return out;
  } catch (e) {
    log('ERROR', 'Analysis failed', e.message);
    return "抱歉，系統忙碌中 🙏";
  }
}

/* ---------------- 固定模板 ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const TPL_BAG = [
  "包包可以處理 💼 會依材質調整，請放心交給 C.H 精緻洗衣 😊",
];

const TPL_SHOE = [
  "鞋子可以清潔 👟 會依材質處理，請放心 😊",
];

/* =================== 智能客服回覆 =================== */
async function smartAutoReply(inputText) {
  if (!inputText) return null;
  
  const text = normalize(inputText);
  if (isEmojiOrPuncOnly(text)) return null;
  if (!maybeLaundryRelated(text)) return null;

  let reply = null;

  // 送洗/收件
  if (/(送洗|我要送洗|收衣|收件|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    if (isSaturday()) {
      reply = addr ? `週六公休，明日會去收回 😊 地址：${addr}` : "週六公休，明日會去收回 😊";
    } else {
      reply = addr ? `好的 😊 我們會去收回，地址：${addr}` : "好的 😊 我們會去收回";
    }
  }
  // 付款 - 回傳特殊標記
  else if (/(付款|結帳|支付|刷卡|line ?pay|信用卡|匯款)/i.test(text)) {
    return "payment_request"; // 特殊標記，由 message.js 處理
  }
  // 進度查詢
  else if (/(洗好了嗎|可以拿了嗎|進度|查進度)/.test(text)) {
    reply = `線上查詢 🔍\n👉 ${CHECK_STATUS_URL}`;
  }
  // 營業時間
  else if (/(幾點開|幾點關|營業|開門|關門|今天有開)/.test(text)) {
    if (BUSINESS_HOURS_TEXT_ENV) {
      reply = BUSINESS_HOURS_TEXT_ENV;
    } else if (isSaturday()) {
      reply = "今天週六公休，明日週日有營業 😊";
    } else {
      reply = "營業時間：週一至週日 10:30–20:00（週六公休）😊";
    }
  }
  // 包包
  else if (/(包包|名牌包|手提袋|背包)/.test(text)) {
    reply = pick(TPL_BAG);
  }
  // 鞋子
  else if (/(鞋子|球鞋|運動鞋|皮鞋)/.test(text)) {
    reply = pick(TPL_SHOE);
  }
  // AI Fallback
  else {
    if (IS_DEVELOPMENT && USE_MOCK) {
      reply = "【測試模式】模擬 AI 回覆 😊";
    } else {
      try {
        const aiReply = await retryWithBackoff(async () => {
          return await openaiClient.chat.completions.create({
            model: "gpt-4",
            messages: [
              { role: "system", content: "你是 C.H 精緻洗衣 客服，用自然口語繁中、1-3 句。" },
              { role: "user", content: text }
            ],
            temperature: 0.85,
            max_tokens: 220
          });
        });
        reply = aiReply?.choices?.[0]?.message?.content?.trim() || "我們會與您確認，謝謝 😊";
      } catch (e) {
        log('ERROR', 'AI reply failed', e.message);
        reply = "系統忙碌中 🙏";
      }
    }
  }

  return reply;
}

/* =================== 綠界付款功能 =================== */
function createECPayPaymentLink(userId, userName, amount) {
  const { ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV, RAILWAY_STATIC_URL } = process.env;

  if (!ECPAY_MERCHANT_ID || !ECPAY_HASH_KEY || !ECPAY_HASH_IV) {
    log('ERROR', '缺少綠界環境變數');
    throw new Error('綠界環境變數未設定');
  }

  const baseURL = RAILWAY_STATIC_URL || 'https://stain-bot-production-0fac.up.railway.app';
  const merchantTradeNo = `CH${Date.now()}`;
  
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const tradeDate = `${year}/${month}/${day} ${hour}:${minute}:${second}`;

  const paymentData = {
    MerchantID: ECPAY_MERCHANT_ID,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: 'CH精緻洗衣服務',
    ItemName: '洗衣服務費用',
    ReturnURL: `${baseURL}/payment/ecpay/callback`,
    ChoosePayment: 'ALL',
    EncryptType: 1,
    CustomField1: userId,
    CustomField2: userName
  };

  try {
    paymentData.CheckMacValue = generateECPayCheckMacValue(paymentData);
    const params = new URLSearchParams(paymentData).toString();
    const paymentLink = `https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5?${params}`;
    
    log('PAYMENT', `綠界連結已生成: ${merchantTradeNo}, ${amount}元, 客戶=${userName}`);
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
  getCacheStats: () => ({ size: brandCache.size }),
  clearCache: () => {
    const size = brandCache.size;
    brandCache.clear();
    log('CACHE', `Cleared ${size} entries`);
    return size;
  }
};
