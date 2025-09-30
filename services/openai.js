// services/openai.js
const { OpenAI } = require('openai');

// ===== OpenAI Client =====
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ===== 固定連結（可用 .env 覆蓋）=====
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL     = process.env.LINE_PAY_URL      || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL        = process.env.ECPAY_URL         || "https://p.ecpay.com.tw/55FFE71";

// ===== 小工具 =====
function ensureEmoji(s, emoji = '🙂') {
  if (!s) return s;
  if (/[😀-🙏🏻]|🙂|😊|✨|👍|👉|💁|🧼|💡|✅|📞|📍|💙|⏳|🔍/.test(s)) return s;
  return s + ' ' + emoji;
}

function normalize(input = '') {
  const fw = '０１２３４５６７８９';
  const hw = '0123456789';
  let out = (input || '').trim();
  out = out.replace(/[０-９]/g, ch => hw[fw.indexOf(ch)]);
  return out;
}

// 後備：台灣地址抽取（含樓層）
function extractTWAddress(text = '') {
  const re = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,20}?(?:區|市|鎮|鄉)[^，。\s]{0,20}?(?:路|街|大道|巷|弄)[0-9０-９]{1,4}號(?:之[0-9０-９]{1,2})?(?:[，,\s]*(?:[0-9０-９]{1,2}樓(?:之[0-9０-９]{1,2})?|[0-9０-９]{1,2}F))?/i;
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, '') : '';
}

// 文字中的百分比自動下調 N%
function reducePercentages(s, delta = 5) {
  return s.replace(/(\d{1,3})\s*%/g, (match, p1) => {
    let num = parseInt(p1, 10);
    if (Number.isNaN(num)) return match;
    // 避免把非常低的數字降成 0
    if (num > 5) num = Math.max(num - delta, 1);
    return `${num}%`;
  });
}

// ===== 1) 智能污漬分析（分析詳盡、建議精簡）=====
async function analyzeStainWithAI(imageBuffer, materialInfo = '', labelImageBuffer = null) {
  const base64Image = imageBuffer.toString('base64');
  const base64Label = labelImageBuffer ? labelImageBuffer.toString('base64') : '';

  const userContent = [];
  userContent.push({ type: 'text', text: '請盡可能詳細分析此物品與污漬，並提供簡短的清潔建議。' });
  if (materialInfo) {
    userContent.push({ type: 'text', text: `衣物材質：${materialInfo}` });
  }
  userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } });
  if (base64Label) {
    userContent.push({ type: 'text', text: '以下是洗滌標籤，僅供參考：' });
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `
你是 C.H 精緻洗衣 的專業清潔顧問，請用口語化繁體中文，結構如下：

【分析】
- 物品與污漬狀況（2–4 句，可詳細描述形狀、範圍、顏色、滲入深度）
- 材質特性（如：羊毛易縮水、絲質怕水、帆布易吸附）
- 污漬可能來源判斷（如油漬、汗漬、墨水、咖啡）
- 清潔成功機率（可附百分比，但務必偏保守，避免太高；用「有機會改善」「可望提升外觀」等字眼）
- 品牌推測（可依花紋/五金/版型說「可能為／推測為」）
- 若為精品包，補充年份與稀有性（如「此花紋常見於 2010 年代初期，較少見」）
- 結尾固定加：我們會根據材質特性進行適當清潔，確保最佳效果。

【清潔建議】
- 只給 1–2 句簡短建議（不提供 DIY 步驟與藥劑比例）
- 可說「若擔心，建議交給 C.H 精緻洗衣專業處理，避免自行操作造成二次損傷」
`
      },
      { role: 'user', content: userContent }
    ],
    temperature: 0.6,
    max_tokens: 1000
  });

  let out = resp.choices?.[0]?.message?.content || '';
  out = out.replace(/\*\*/g, '');

  // 成功機率往下調 5%
  out = reducePercentages(out, 5);

  // 安全兜底：若模型忘了固定句
  if (!/我們會根據材質特性進行適當清潔，確保最佳效果。/.test(out)) {
    out += `\n我們會根據材質特性進行適當清潔，確保最佳效果。`;
  }
  return out;
}

// ===== 2) 智能自動回覆（AI 高判斷 → 命中再套規則）=====
async function smartAutoReply(inputText) {
  const text = normalize(inputText);

  // 先用 AI 做結構化理解（意圖 + 地址 + AI 回覆草稿）
  const classify = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
`你是「C.H 精緻洗衣」的客服助理。請理解使用者訊息並輸出「唯一一段 JSON」，不要額外文字。

需要：
1) 意圖（多選布林）：
   - payment_intent：付款/支付/刷卡/Line Pay
   - pickup_request：要到府收件/來收衣/取件
   - address_inquiry：問我們是否有他的地址
   - duration_query：詢問處理時間/幾天/多久
   - progress_query：查詢清洗是否完成/進度/可以拿了嗎
   - child_item：兒童/嬰兒用品（手推車/嬰兒車/汽座/安全座椅/小孩坐墊等廣義描述）
   - cleaning_topic：一般清潔/能否清洗/污漬/材質/掉色縮水等
   - hours_or_location：營業時間/地址/怎麼去/在哪
   - price_or_quote：價格/多少錢/費用/估價
   - service_scope：能不能洗XXX（包包/鞋/西裝/羽絨/窗簾/地毯等）
2) 擷取地址（若可能）：{"full": "...", "floor": "..."}，沒有就空字串
3) 產出一段 ai_reply（繁體中文、口語化、溫和、專業；避免保證語；盡量安撫「我們會盡量處理，請放心」；結尾加一個表情符號）

只輸出 JSON：
{
  "intents": { ... },
  "address": {"full":"", "floor":""},
  "ai_reply": "..."
}`
      },
      { role: 'user', content: text }
    ],
    temperature: 0.2,
    max_tokens: 600
  });

  // 安全解析 JSON
  let parsed;
  const raw = classify.choices?.[0]?.message?.content || '';
  try {
    const jsonStr = (raw.match(/\{[\s\S]*\}$/) || [raw])[0];
    parsed = JSON.parse(jsonStr);
  } catch {
    // 若解析失敗，退回規則 + 自由 AI
    return await legacyFallback(text);
  }

  const intents = parsed?.intents || {};
  let addr = (parsed?.address?.full || '').trim();
  const floor = (parsed?.address?.floor || '').trim();
  const aiReply = (parsed?.ai_reply || '').trim();

  // 後備地址抽取
  if (!addr) addr = extractTWAddress(text);
  if (addr && floor && !addr.includes(floor)) addr += floor;

  // ===== 命中規則：回固定話術（語氣溫和）=====
  if (intents.payment_intent) {
    return (
      '以下提供兩種付款方式，您可以依方便選擇：\n\n' +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      '感謝您的支持與配合 💙'
    );
  }

  if (intents.pickup_request) {
    return addr
      ? `好的 😊 我們會安排到府收件\n地址：${addr}`
      : '好的 😊 我們會安排到府收件';
  }

  if (intents.address_inquiry) {
    return '有的，我們都有紀錄的 😊';
  }

  if (intents.duration_query) {
    return '一般清潔作業時間約 7–10 天，會依材質與現場工作量微調喔 ⏳';
  }

  if (intents.progress_query) {
    return `您可以這邊線上查詢進度 🔍\n👉 ${CHECK_STATUS_URL}`;
  }

  if (intents.child_item) {
    // 更彈性抓與小朋友用品相關語意
    return '像手推車、嬰兒車、汽座、坐墊等兒童用品，我們都有「拆洗＋深層清潔＋殺菌除味」服務，處理會盡量貼材質安全，請放心 ✨\n要詳細了解請按 2';
  }

  if (intents.price_or_quote) {
    return '費用會依材質、尺寸與髒污狀況略有差異，建議帶來現場或拍照給我們評估，會提供清楚報價與建議方案 😊';
  }

  if (intents.hours_or_location) {
    return ensureEmoji(aiReply || '我們的營業時間與地址可在官方帳號資訊查看，若不確定也可以直接留個時間，我們幫您安排～');
  }

  if (intents.service_scope) {
    return '多數材質與品項我們都能處理，會依材質與做工選用合適流程；我們會盡量讓狀態更好，您可以放心交給 C.H 精緻洗衣 ✨';
  }

  if (intents.cleaning_topic) {
    return ensureEmoji(
      aiReply ||
      '針對材質與狀況我們會先評估，再選擇溫和安全的方式處理；污漬、泛黃或縮水等狀況我們都會盡量改善，若擔心也可以直接交給 C.H 精緻洗衣，我們會細心照顧 😊'
    );
  }

  // ===== 其他：直接使用 AI 建議回覆（已帶語氣要求）=====
  return ensureEmoji(aiReply || (await aiFreeReply(text)));
}

// ===== 後備：傳統規則 + AI 回覆 =====
async function legacyFallback(text) {
  const lower = text.toLowerCase();

  if (/(付款|支付|匯款|line pay|刷卡)/i.test(text)) {
    return (
      '以下提供兩種付款方式，您可以依方便選擇：\n\n' +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      '感謝您的支持與配合 💙'
    );
  }

  if (/(收衣|收件|取件|來收)/.test(text)) {
    const addr = extractTWAddress(text);
    return addr
      ? `好的 😊 我們會安排到府收件\n地址：${addr}`
      : '好的 😊 我們會安排到府收件';
  }

  if (/有地址嗎|記錄地址/.test(text)) {
    return '有的，我們都有紀錄的 😊';
  }

  if (/(進度|洗好了嗎|可以拿了嗎|完成了嗎)/.test(text)) {
    return `您可以這邊線上查詢進度 🔍\n👉 ${CHECK_STATUS_URL}`;
  }

  if (/(多久|幾天|時間)/.test(text)) {
    return '一般清潔作業時間約 7–10 天，會依材質與現場工作量微調喔 ⏳';
  }

  if (/(手推車|推車|嬰兒車|汽座|安全座椅|小孩座椅|兒童坐墊|嬰兒坐墊)/.test(text)) {
    return '像手推車、嬰兒車、汽座、坐墊等兒童用品，我們都有「拆洗＋深層清潔＋殺菌除味」服務，處理會盡量貼材質安全，請放心 ✨\n要詳細了解請按 2';
  }

  if (/(包包|鞋|鞋子|衣服|西裝|羽絨|窗簾|地毯).*(可以洗|能不能|能洗|可處理)/.test(text)) {
    return '這些品項我們大多能處理，會依材質與做工選擇合適方式；我們都會盡量讓狀態更好，您可以放心交給 C.H 精緻洗衣 ✨';
  }

  if (/(污漬|髒污|泛黃|掉色|縮水|變形)/.test(text)) {
    return '我們會先評估材質與狀況，再以溫和、安全的方式處理；上述狀況都會盡量改善，若擔心可以直接交給 C.H 精緻洗衣，我們會細心照顧 😊';
  }

  return ensureEmoji(await aiFreeReply(text));
}

// ===== 自由 AI 回覆（專業、溫和、保守、不給硬保證）=====
async function aiFreeReply(text) {
  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
`你是「C.H 精緻洗衣」的專業客服，請用繁體中文、口語化、溫和有禮的語氣回覆。
原則：
- 盡量直接回答客人的重點。
- 可處理類型（包包/鞋/衣物/窗簾/地毯…）→ 可說「我們可以處理，會依材質調整方式，盡量讓狀態更好」。
- 污漬/泛黃/掉色/縮水/變形 → 用「我們會盡量處理」「需實物檢查」「先做不顯眼處測試」的保守說法。
- 時間若被問到 → 一般約 7–10 天（仍依現場與材質調整）。
- 嬰兒/兒童用品（手推車/汽座/坐墊）→ 我們有「拆洗＋深層清潔＋殺菌除味」服務，可放心。
- 可自然提到：若擔心，建議交給 C.H 精緻洗衣評估與處理。
- 不要提供過於詳細的 DIY 步驟或藥水比例，以免造成誤用。
- 結尾加 1 個合適表情符號。`
      },
      { role: 'user', content: text }
    ],
    temperature: 0.6,
    max_tokens: 600
  });
  return resp.choices?.[0]?.message?.content || '';
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply
};
