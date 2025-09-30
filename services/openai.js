// open.js
// 功能：1) analyzeStainWithAI（影像多模態分析）
//      2) getAIResponse（純文字客服）
//      3) smartAutoReply（AI 先回、信心不足再用 Sheets；含「進度查詢」「清潔時間」「到府收件」「地址紀錄」「付款強意圖」等特例）
//      4) generateServiceRecommendation / handleCustomerInquiry（可選）

const { OpenAI } = require('openai');

// ====== 環境設定（導流開關與品牌資訊）======
// 預設不顯示 CTA，如需顯示，.env 設 ENABLE_CTA=true 並填其他欄位。
const ENABLE_CTA    = String(process.env.ENABLE_CTA || 'false').toLowerCase() === 'true';
const SERVICE_NAME  = process.env.SERVICE_NAME || 'C.H 精緻洗衣';
const SERVICE_PHONE = process.env.SERVICE_PHONE || '';
const SERVICE_ADDR  = process.env.SERVICE_ADDRESS || '';
const BOOKING_URL   = process.env.BOOKING_URL || '';
const BOOKING_TEXT  = process.env.BOOKING_URL_TEXT || '點我預約與查詢';

// 進度查詢連結（例如你的 LIFF）
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || '';

// ====== OpenAI 客戶端 ======
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ====== 小工具 ======
function buildServiceCTA() {
  if (!ENABLE_CTA) return ''; // 預設不顯示
  const lines = [];
  lines.push(`【${SERVICE_NAME}｜專業清潔服務】`);
  if (BOOKING_URL) lines.push(`・${BOOKING_TEXT}：${BOOKING_URL}`);
  if (SERVICE_PHONE) lines.push(`・連絡電話：${SERVICE_PHONE}`);
  if (SERVICE_ADDR) lines.push(`・地址：${SERVICE_ADDR}`);
  lines.push('・我們會先實物檢查，依材質與狀況提供最合適的處理方案。');
  return '\n\n' + lines.join('\n');
}

const DOMAIN_KEYWORDS = [
  '洗','清潔','乾洗','去漬','污','毛球','縮水','發黃','發霉','除臭',
  '包','鞋','外套','大衣','襯衫','羽絨','羊毛','絲','棉','皮革','麂皮',
  '洗標','水洗標','保養','送洗','價錢','價格','費用','運費','收送','到府',
  '真空收納','進度','完成','好了嗎','好沒','查詢','多久','幾天','要多長','需要幾天','大概多久',
  '收衣','收件','來收','收回','取件',
  '付款','支付','結帳','刷卡','line pay','信用卡','匯款','轉帳'
];

function isOnTopic(text = '') {
  const t = (text || '').toLowerCase();
  return DOMAIN_KEYWORDS.some(k => t.includes(k));
}

// 粗略檢測是否「強烈付款意圖」
function isStrongPaymentIntent(text = '') {
  const t = text.toLowerCase();
  const payKw = /(付款|支付|結帳|刷卡|line\s*pay|信用卡|匯款|轉帳|付錢|給你錢)/;
  const actionKw = /(要|可以|請|給|連結|網址|馬上|現在|怎麼付|如何付款|如何支付)/;
  return payKw.test(t) && actionKw.test(t);
}

// 台灣地址 + 樓層偵測（例：新北市板橋區中山路100號、5樓、5樓之2）
function extractTWAddress(text = '') {
  const re = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,20}?(?:區|市|鎮|鄉)[^，。\s]{0,20}?(?:路|街|大道|巷|弄)[0-9０-９]{1,4}號(?:之[0-9０-９]{1,2})?(?:[，,\s]*(?:[0-9０-９]{1,2}樓(?:之[0-9０-９]{1,2})?|[0-9０-９]{1,2}F))?/i;
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, '') : '';
}

// 確保回覆含有一個表情符號（AI or 我們的固定回覆都更友善）
function ensureEmoji(s, emoji = '🙂') {
  if (!s) return s;
  // 若已有常見 emoji 就不再附加
  if (/[😀-🙏🏻]|🙂|😊|✨|👍|👉|💁|🧼|💡|✅|📞|📍|💙/.test(s)) return s;
  return s + ' ' + emoji;
}

// ====== 風險與機率保守化處理 ======
function postProcessAnalysis(text) {
  if (!text) return text;

  // 1) 機率上限（避免過度自信），若模型回 > 90%，降到 85%
  text = text.replace(/(\d{2,3})\s*%/g, (m, p1) => {
    const n = parseInt(p1, 10);
    const capped = Math.min(n, 85);
    return `${capped}%`;
  });

  // 2) 加註風險聲明（若未出現）
  if (!/僅依影像|需實物檢查|實際結果以現場/.test(text)) {
    text += `\n\n（以上判斷僅依影像與描述初步推測，實際結果需以現場實物檢查為準。）`;
  }

  // 3) 確保標準結尾與護理建議段落格式（延續你原本規格）
  if (text.includes('護理建議')) {
    if (!text.includes('確保最佳效果。')) {
      text = text.replace('護理建議', `我們會根據材質特性進行適當清潔，確保最佳效果。\n\n護理建議`);
    } else {
      text = text.replace(/確保最佳效果。(\s*)護理建議/, '確保最佳效果。\n\n護理建議');
    }
  } else {
    if (!text.endsWith('確保最佳效果。')) {
      text += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }
  }

  return text;
}

/**
 * 智能污漬分析服務（主圖＋可選洗標＋可選材質/補充）
 */
async function analyzeStainWithAI(imageBuffer, materialInfo = '', labelImageBuffer = null, customerContext = '') {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error('imageBuffer 必須為有效的 Buffer');
  }

  const base64Image = imageBuffer.toString('base64');
  const base64Label = labelImageBuffer ? labelImageBuffer.toString('base64') : '';

  const userContent = [];
  userContent.push({ type: 'text', text: `請分析此物品並提供專業清潔建議。${customerContext ? `客戶補充：${customerContext}` : ''}` });
  if (materialInfo) userContent.push({ type: 'text', text: `衣物材質：${materialInfo}` });
  userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } });
  if (base64Label) {
    userContent.push({ type: 'text', text: '以下是該物品的洗滌標籤資訊，請一併參考。' });
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  try {
    const openaiResponse = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `你是專業的精品清潔顧問，請按照以下結構分析：

【專業分析報告】
1. 物品與污漬狀況描述（流暢口語化中文）
2. 清洗成功機率評估（精確百分比，語氣保守）
3. 品牌與價值辨識（使用「可能為 / 推測為」，避免真假鑑定與保證）
4. 材質特性與清潔風險（標註易掉色、縮水、塌陷、變形等風險）
5. 款式特徵與設計元素（專業但好懂）
6. 若為精品：年份/稀有性（若可辨識，再用推測語氣）

分析結尾務必使用：「我們會根據材質特性進行適當清潔，確保最佳效果。」
之後換新段落提供「護理建議」。

風格準則：
- 全程使用繁體中文
- 不提及處理時間長短
- 不使用保證語（如百分之百、一定、保證）
- 若資訊不足，請明確寫「需實物檢查」`
        },
        { role: 'user', content: userContent }
      ],
      max_tokens: 1200,
      temperature: 0.6
    });

    let analysisResult = openaiResponse.choices?.[0]?.message?.content || '';
    analysisResult = analysisResult.replace(/\*\*/g, ''); // 清理舊格式符號
    analysisResult = postProcessAnalysis(analysisResult);

    const cta = buildServiceCTA();
    return analysisResult + cta;

  } catch (err) {
    console.error('analyzeStainWithAI error:', err);
    const tail = BOOKING_URL && ENABLE_CTA ? `\n${BOOKING_TEXT}：${BOOKING_URL}` : '';
    return ensureEmoji(`${SERVICE_NAME} 系統忙碌中，建議先把物品帶來現場，由我們實物檢查後再提供合適的處理方式。${tail}`, '😊');
  }
}

/**
 * 純文字客服回覆（含進度查詢捷徑）
 */
async function getAIResponse(text, conversationHistory = '') {
  if (!text) return '';

  // 特殊情境：客人查詢進度（最優先處理）
  const progressKeywords = ['洗好', '完成', '進度', '好了嗎', '好沒', '查詢'];
  if (CHECK_STATUS_URL && progressKeywords.some(k => text.includes(k))) {
    return ensureEmoji(`您可以直接透過這裡查詢清潔進度：點我查看 👉 ${CHECK_STATUS_URL}`, '🙂');
    }

  // 離題不回
  if (!isOnTopic(text)) return '';

  const messages = [
    {
      role: 'system',
      content: `你是「${SERVICE_NAME}」的客服，請遵守：
- 口語化繁體中文，親切專業
- 結尾加 1 個適當表情符號
- 避免艱深專業術語，用客人聽得懂的話
- 不提處理時間長短
- 僅限洗衣/清潔/保養相關；離題不要回應
- 避免保證語（如 一定、百分之百、保證）`
    }
  ];
  if (conversationHistory) {
    messages.push({ role: 'system', content: `對話背景：${conversationHistory}` });
  }
  messages.push({ role: 'user', content: text });

  const aiResponse = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.7,
    max_tokens: 400
  });

  return ensureEmoji(aiResponse.choices?.[0]?.message?.content || '', '🙂');
}

/**
 * 讓 AI 先語意判斷與直接回覆（回 JSON，含信心分數）
 */
async function semanticReplyViaAI(text, conversationHistory = '') {
  const messages = [
    {
      role: 'system',
      content: `你是「${SERVICE_NAME}」的客服助理。請僅輸出 JSON，欄位：
{
  "is_on_topic": boolean,
  "intent": "price|stain|material|care|status|other",
  "confidence": number,          // 0~1
  "answer": string,              // 若能直接回覆，請給口語化繁中、友善、不提時間長短、結尾 1 個表情符號
  "needs_fallback": boolean,
  "keywords": string[]
}
規則：避免「保證、一定、百分之百」等字；離題請標 is_on_topic=false 且 answer=""。`
    },
    conversationHistory ? { role: 'system', content: `對話背景：${conversationHistory}` } : null,
    { role: 'user', content: text }
  ].filter(Boolean);

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.4,
    max_tokens: 360
  });

  let parsed = null;
  try {
    parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    parsed = { is_on_topic: false, intent: 'other', confidence: 0, answer: '', needs_fallback: true, keywords: [] };
  }
  if (typeof parsed.is_on_topic !== 'boolean') parsed.is_on_topic = false;
  if (!parsed.intent) parsed.intent = 'other';
  if (typeof parsed.confidence !== 'number') parsed.confidence = 0;
  if (typeof parsed.answer !== 'string') parsed.answer = '';
  if (typeof parsed.needs_fallback !== 'boolean') parsed.needs_fallback = true;
  if (!Array.isArray(parsed.keywords)) parsed.keywords = [];

  return parsed;
}

/**
 * 智能自動回覆（AI 先回；低信心才用 Sheets；最後記錄未學）
 * 特例順序：
 * 1) 進度查詢
 * 2) 清潔時間多久
 * 3) 付款強意圖（固定版面＋兩個網址）
 * 4) 問我們是否有地址
 * 5) 要求到府收件（含地址偵測與重複；若無地址→「我們會去收回的」）
 * 6) 其餘 → AI→Sheets 流程
 */
async function smartAutoReply(text, opts = {}) {
  if (!text) return '';

  // 1) 進度查詢（最優先）
  const progressKeywords = ['洗好', '完成', '進度', '好了嗎', '好沒', '查詢'];
  if (CHECK_STATUS_URL && progressKeywords.some(k => text.includes(k))) {
    return ensureEmoji(`您可以直接透過這裡查詢清潔進度：點我查看 👉 ${CHECK_STATUS_URL}`, '🙂');
  }

  // 2) 清潔時間多久
  const timeKeywords = ['多久','幾天','要多長','需要幾天','大概多久'];
  if (timeKeywords.some(k => text.includes(k))) {
    return '一般清潔作業時間約 7–10 天（仍需依現場狀況與工作量為準）🙂';
  }

  // 3) 付款強意圖（固定版面＋兩個網址）
  if (isStrongPaymentIntent(text)) {
    return (
      '付款方式\n' +
      '以下提供兩種付款方式，您可以依方便選擇：\n\n' +
      '1️⃣ LINE Pay 付款連結\n' +
      'https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt\n\n' +
      '2️⃣ 信用卡付款（綠界 ECPay）\n' +
      'https://p.ecpay.com.tw/55FFE71\n\n' +
      '感謝您的支持與配合 💙'
    );
  }

  // 4) 問我們有沒有地址（「有地址嗎」「地址有嗎」「你們有我的地址嗎」等）
  const askAddrRe = /(有.*地址.*嗎|地址.*有.*嗎|你們.*有.*地址.*嗎|還有.*地址.*嗎|是否.*有.*地址)/i;
  if (askAddrRe.test(text)) {
    return '有的，我們都有紀錄的 😊';
  }

  // 5) 要求到府收件（含地址偵測與重複；若無地址就回「我們會去收回的」）
  const pickupKeywords = ['收衣','收件','來收','收回','取件'];
  if (pickupKeywords.some(k => text.includes(k))) {
    const addr = extractTWAddress(text);
    if (addr) {
      return `好的 😊 我們會安排到府收件，地址確認：${addr}`;
    }
    return '好的 😊 我們會去收回的';
  }

  // 6) 一般 AI→Sheets 流程
  // 與洗衣無關 → 不回
  if (!isOnTopic(text)) return '';

  // 先 AI 結構化理解
  const ai = await semanticReplyViaAI(text, opts.conversationHistory || '');
  const CONF_THRESHOLD = 0.72;

  if (!ai.is_on_topic) return '';

  if (ai.confidence >= CONF_THRESHOLD && !ai.needs_fallback && ai.answer) {
    return ensureEmoji(ai.answer, '🙂');
  }

  // 低信心 → FAQ（Google Sheets）
  let faqAnswer = null;
  try {
    const sheets = require('./googleSheets');
    faqAnswer = await sheets.getFAQAnswer(text, ai.keywords || []);
  } catch (e) {}
  if (faqAnswer) return ensureEmoji(faqAnswer, '🙂');

  // 記錄未學
  if (opts.userId) {
    try {
      const sheets = require('./googleSheets');
      await sheets.logUnanswered(opts.userId, text);
    } catch (e) {}
  }

  if (ai.answer) return ensureEmoji(ai.answer, '🙂');

  return '想更準確判斷，建議上傳清晰照片或補充材質/污漬形成原因，我再幫你評估喔～ 🙂';
}

// =====（可選）關鍵字導向服務建議（柔性 CTA，預設關）=====
function generateServiceRecommendation(userQuestion = '', analysisResult = '') {
  const map = {
    '污漬': '專業去漬服務',
    '清洗': '精緻清洗服務',
    '保養': '材質養護服務',
    '修復': '基本修復服務',
    '包': '精品包清潔養護',
    '鞋': '鞋類專業清潔',
    '羊毛': '羊毛製品處理',
    '絲': '絲質衣物處理',
    '皮': '皮革/麂皮處理'
  };
  let service = '專業清潔服務';
  const text = `${userQuestion} ${analysisResult}`;
  for (const k of Object.keys(map)) {
    if (text.includes(k)) { service = map[k]; break; }
  }
  const cta = buildServiceCTA();
  return `【建議服務】${service}\n我們會視材質狀況擬定處理方案，先評估再動手，降低風險。${cta}`;
}

/**
 * 完整客服流程（影像分析 + 對話 + 建議）
 */
async function handleCustomerInquiry(params) {
  const {
    message,
    imageBuffer,
    materialInfo,
    labelImageBuffer,
    customerContext,
    conversationHistory
  } = params || {};

  const result = {
    analysis: '',
    chatResponse: '',
    serviceRecommendation: '',
    hasUrgentIssue: false
  };

  try {
    if (imageBuffer) {
      result.analysis = await analyzeStainWithAI(
        imageBuffer, materialInfo, labelImageBuffer, customerContext
      );
      result.serviceRecommendation = generateServiceRecommendation(message || '', result.analysis);
      result.hasUrgentIssue =
        /精品|嚴重掉色|結構性損傷|皮革硬化|發霉面積大/.test(result.analysis);
    }

    if (message) {
      result.chatResponse = await getAIResponse(message, conversationHistory);
    }
    return result;

  } catch (e) {
    console.error('handleCustomerInquiry error:', e);
    const tail = BOOKING_URL && ENABLE_CTA ? `\n${BOOKING_TEXT}：${BOOKING_URL}` : '';
    return {
      analysis: '',
      chatResponse: ensureEmoji(`${SERVICE_NAME} 系統忙碌中，建議先到店由我們實物檢查後再提供建議。${tail}`, '😊'),
      serviceRecommendation: ENABLE_CTA ? buildServiceCTA() : '',
      hasUrgentIssue: false
    };
  }
}

module.exports = {
  analyzeStainWithAI,
  getAIResponse,
  smartAutoReply,
  generateServiceRecommendation,
  handleCustomerInquiry
};
