// services/openai.js
const { OpenAI } = require('openai');

// 初始化 OpenAI 客户端
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 固定設定
const CHECK_STATUS_URL = "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL = "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL = "https://p.ecpay.com.tw/55FFE71";

/**
 * 智能污漬分析服務
 */
async function analyzeStainWithAI(imageBuffer, materialInfo = '', labelImageBuffer = null) {
  const base64Image = imageBuffer.toString('base64');
  let base64Label = '';
  if (labelImageBuffer) base64Label = labelImageBuffer.toString('base64');

  const userContent = [
    { type: 'text', text: '請分析此物品並提供專業清潔建議。' }
  ];
  if (materialInfo) {
    userContent.push({ type: 'text', text: `衣物材質：${materialInfo}` });
  }
  userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } });
  if (base64Label) {
    userContent.push({ type: 'text', text: '以下是該物品的洗滌標籤資訊，請一併參考。' });
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `你是專業的精品清潔顧問，請按照以下格式分析圖片：
1. 以流暢口語化中文描述物品與污漬狀況
2. 清洗成功機率（精確百分比）
3. 品牌辨識（使用「可能為」、「推測為」等專業用語）
4. 材質分析（說明材質特性與清潔注意點）
5. 款式特徵（專業術語描述設計元素）
6. 若為精品包，請提供年份與稀有性資訊（若可辨識）
7. 分析結尾：「我們會根據材質特性進行適當清潔，確保最佳效果。」
8. 新段落：護理建議（依材質和款式給日常維護建議）`
      },
      { role: 'user', content: userContent }
    ]
  });

  let result = resp.choices[0].message.content || '';
  result = result.replace(/\*\*/g, '');
  result = result.replace(/我們會以不傷害材質盡量做清潔處理。/g, '');

  if (result.includes('護理建議')) {
    if (!result.includes('確保最佳效果。')) {
      result = result.replace('護理建議', `我們會根據材質特性進行適當清潔，確保最佳效果。\n\n護理建議`);
    } else {
      result = result.replace(/確保最佳效果。(\s*)護理建議/, '確保最佳效果。\n\n護理建議');
    }
  } else {
    if (!result.endsWith('確保最佳效果。')) {
      result += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }
  }

  return result;
}

/**
 * 智能客服回覆（含規則判斷）
 */
async function smartAutoReply(text) {
  if (!text) return '';
  const lower = text.toLowerCase();

  // --- 規則判斷 ---
  if (text.includes('付款') || text.includes('付錢') || text.includes('結帳')) {
    return `以下提供兩種付款方式，您可以依方便選擇：\n\n1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n感謝您的支持與配合 💙`;
  }

  if (text.includes('收衣') || text.includes('收件') || text.includes('取件')) {
    const addressMatch = text.match(/(新北市|台北市|桃園市).+[0-9]+號.*(樓)?/);
    if (addressMatch) {
      return `好的 😊 我們會去收回的\n地址：${addressMatch[0]}`;
    }
    return '好的 😊 我們會去收回的';
  }

  if (text.includes('查詢') || text.includes('洗好') || text.includes('完成') || text.includes('進度')) {
    return `您可以點此查詢清潔進度 👉 ${CHECK_STATUS_URL}`;
  }

  if (text.includes('有地址嗎') || text.includes('記錄地址')) {
    return '有的，我們都有紀錄的 😊';
  }

  // --- 交給 AI ---
  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: '你是一個洗衣店客服，需用口語化繁體中文回答，結尾加表情符號，避免專業術語，不提時間長短。訊息與洗衣店無關請不要回應。'
      },
      { role: 'user', content: text }
    ]
  });

  return resp.choices[0].message.content || '';
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply
};
