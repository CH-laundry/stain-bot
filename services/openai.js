// services/openai.js
const { OpenAI } = require('openai');

// === OpenAI Client ===
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// === 固定連結（可先用寫死，之後要可改再環境變數化） ===
const CHECK_STATUS_URL = "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL     = "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL        = "https://p.ecpay.com.tw/55FFE71";

// === 小工具 ===
function ensureEmoji(s, emoji = '🙂') {
  if (!s) return s;
  // 若已有常見 emoji 就不再附加
  if (/[😀-🙏🏻]|🙂|😊|✨|👍|👉|💁|🧼|💡|✅|📞|📍|💙/.test(s)) return s;
  return s + ' ' + emoji;
}

// 抓台灣地址（含樓層）的簡易正則
function extractTWAddress(text = '') {
  const re = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,20}?(?:區|市|鎮|鄉)[^，。\s]{0,20}?(?:路|街|大道|巷|弄)[0-9０-９]{1,4}號(?:之[0-9０-９]{1,2})?(?:[，,\s]*(?:[0-9０-９]{1,2}樓(?:之[0-9０-９]{1,2})?|[0-9０-９]{1,2}F))?/i;
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, '') : '';
}

// === 1) 智能污漬分析（按「1」且上傳圖片才會啟動） ===
async function analyzeStainWithAI(imageBuffer, materialInfo = '', labelImageBuffer = null) {
  const base64Image = imageBuffer.toString('base64');
  let base64Label = '';
  if (labelImageBuffer) {
    base64Label = labelImageBuffer.toString('base64');
  }

  // 組使用者訊息
  const userContent = [];
  userContent.push({ type: 'text', text: '請分析此物品並提供專業清潔建議。' });
  if (materialInfo) {
    userContent.push({ type: 'text', text: `衣物材質：${materialInfo}` });
  }
  userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } });
  if (base64Label) {
    userContent.push({ type: 'text', text: '以下是該物品的洗滌標籤資訊，請一併參考。' });
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  // 請模型輸出「分析 + 護理建議」，並加上風險/保守語氣
  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `你是 C.H 精緻洗衣 的專業清潔顧問，請按照以下格式分析圖片（繁體中文）：
1. 物品與污漬狀況描述（口語化、清楚）
2. 清洗成功機率（精確百分比；語氣保守，上限請勿超過 85%）
3. 品牌辨識（用「可能為／推測為」，避免鑑定口吻）
4. 材質特性與清潔注意（特別標註：縮水、掉色、變形、脫膠等風險；先做不顯眼處測試）
5. 款式特徵（專業但好懂）
6. 若為精品且可辨識，再述年份／稀有性（仍用推測語氣）

重要原則：
- 污漬類問題用「盡量處理」的保守說法，避免保證語（如 一定、百分之百、保證）。
- 縮水／掉色等高風險，務必強調「需實物檢查」與「先做不顯眼處測試」。
- 不主動提處理時間。
- 分析段落結尾務必加上：「我們會根據材質特性進行適當清潔，確保最佳效果。」
- 之後換新段落提供「護理建議」（依材質與款式給日常維護重點）。
`
      },
      { role: 'user', content: userContent }
    ]
  });

  let analysisResult = resp.choices[0].message.content || '';
  // 清理符號
  analysisResult = analysisResult.replace(/\*\*/g, '');
  // 兼容舊版結尾句移除
  analysisResult = analysisResult.replace(/我們會以不傷害材質盡量做清潔處理。/g, '');

  // 確保有標準結尾、護理建議分段
  if (analysisResult.includes('護理建議')) {
    if (!analysisResult.includes('確保最佳效果。')) {
      analysisResult = analysisResult.replace('護理建議', `我們會根據材質特性進行適當清潔，確保最佳效果。\n\n護理建議`);
    } else {
      analysisResult = analysisResult.replace(/確保最佳效果。(\s*)護理建議/, '確保最佳效果。\n\n護理建議');
    }
  } else {
    if (!analysisResult.endsWith('確保最佳效果。')) {
      analysisResult += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }
  }

  return analysisResult;
}

// === 2) 智能客服（規則優先 → 其他交給 AI 高度判斷） ===
async function smartAutoReply(text) {
  if (!text) return '';
  const lower = text.toLowerCase();

  // ---- 進度查詢（固定回覆） ----
  if (text.includes('查詢') || text.includes('洗好') || text.includes('完成') || text.includes('進度')) {
    return ensureEmoji(`您可以點此查詢清潔進度 👉 ${CHECK_STATUS_URL}`, '🙂');
  }

  // ---- 清潔時間（只有問到才回）----
  if (text.includes('多久') || text.includes('幾天') || text.includes('要多長') || text.includes('需要幾天') || text.includes('大概多久')) {
    return '一般清潔作業時間約 7–10 天（仍需依實際材質、污漬程度與現場工作量為準）🙂';
  }

  // ---- 付款（固定兩個連結） ----
  if (text.includes('付款') || text.includes('付錢') || text.includes('結帳') || lower.includes('line pay') || text.includes('刷卡') || text.includes('信用卡')) {
    return (
      '以下提供兩種付款方式，您可以依方便選擇：\n\n' +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      '感謝您的支持與配合 💙'
    );
  }

  // ---- 問我們是否有地址 ----
  if (text.includes('有地址嗎') || text.includes('你們有我的地址嗎') || text.includes('地址有留嗎') || text.includes('記錄地址')) {
    return '有的，我們都有紀錄的 😊';
  }

  // ---- 到府收件（有地址就重複；無地址就回「會去收回的」） ----
  if (text.includes('收衣') || text.includes('收件') || text.includes('取件') || text.includes('來收')) {
    const addr = extractTWAddress(text);
    if (addr) return `好的 😊 我們會去收回的\n地址：${addr}`;
    return '好的 😊 我們會去收回的';
  }

  // ---- 兒童用品（手推車 / 嬰兒推車 / 寶寶汽座…） ----
  if (
    text.includes('手推車') || text.includes('推車') ||
    text.includes('嬰兒推車') || text.includes('嬰兒車') || text.includes('嬰兒手推車') ||
    text.includes('寶寶汽座') || text.includes('汽座') ||
    text.includes('兒童安全座椅') || text.includes('安全座椅') || text.includes('兒童座椅') || text.includes('嬰兒座椅')
  ) {
    return '這類小朋友使用的用品，我們可以做「拆洗＋深層清潔＋殺菌除味」的專業處理，清潔後更安心 ✨\n要詳細了解請按 2';
  }

  // ---- 其餘 → AI 高度判斷（保守專業：縮水/掉色/污漬都不保證，盡量處理） ----
  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `你是「C.H 精緻洗衣」的專業且親切的客服。請用繁體中文、口語化但專業的方式回覆，務必：
- 針對縮水、掉色、變形、脫膠等風險，採保守說法，強調需實物檢查與先做不顯眼處測試。
- 污漬問題用「盡量處理」的說法，不使用保證語（例如：一定、百分之百、保證）。
- 不主動提處理時間（除非客人主動詢問）。
- 回覆要具體可行（例如：先分辨材質、查看洗標、避免熱水、高溫烘、避免自行用強酸強鹼、送至門市評估等）。
- 結尾加 1 個合適的表情符號。
- 若訊息與洗衣/清潔無關，則不要回覆。`
      },
      { role: 'user', content: text }
    ],
    temperature: 0.7,
    max_tokens: 500
  });

  const ai = resp.choices?.[0]?.message?.content || '';
  return ensureEmoji(ai, '🙂');
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply
};
