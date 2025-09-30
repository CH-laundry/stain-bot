const { OpenAI } = require("openai");
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * 智能污漬分析服務
 * 按 1 啟動 → 上傳圖片 → 進行分析
 * 分析結果：物品描述 + 污漬狀況 + 品牌年份推測 + 成功機率(下調5%) + 簡短清潔建議
 */
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
  const base64Image = imageBuffer.toString("base64");
  let base64Label = "";
  if (labelImageBuffer) base64Label = labelImageBuffer.toString("base64");

  const userContent = [];
  userContent.push({ type: "text", text: "請分析此物品並提供專業清潔建議。" });
  if (materialInfo) userContent.push({ type: "text", text: `衣物材質：${materialInfo}` });
  userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } });

  if (base64Label) {
    userContent.push({ type: "text", text: "以下是該物品的洗滌標籤資訊，請一併參考。" });
    userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  const res = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `你是專業的精品清潔顧問，請按照以下格式分析圖片：
1. 簡短描述物品與污漬狀況（2-3句，盡量詳細，推測品牌/年份/款式）
2. 清潔成功機率（用「有機會改善」「可望提升外觀」等，數字比實際低5%）
3. 材質分析（特性 + 注意事項）
4. 結尾統一用：「我們會根據材質特性進行適當清潔，請您放心交給 C.H精緻洗衣。」 
---
接下來新段落：
給出簡短護理建議（避免太多細節，不要讓客人自己處理，最後加一句「若擔心建議交給 C.H精緻洗衣處理 💙」）`,
      },
      { role: "user", content: userContent },
    ],
  });

  let result = res.choices[0].message.content;
  result = result.replace(/\*\*/g, "");
  return result;
}

/**
 * AI 高度判斷回應
 * - 付款需求 → 回兩個固定連結
 * - 要收件 → 回「好的 😊 我們會去收回的」，有地址就重複一遍
 * - 問地址 → 回「有的，我們都有紀錄的 😊」
 * - 清潔時間 → 回「一般時間大約 7-10 天，會依品項不同有所調整哦 ⏳」
 * - 污漬 / 包包 / 鞋子 / 手推車 / 汽座 → 回「我們會盡量處理，請放心交給 C.H精緻洗衣 💙」
 */
async function smartAutoReply(text) {
  const lower = text.toLowerCase();

  // --- 規則判斷 ---
  if (/(付款|結帳|刷卡|付錢|支付)/.test(text)) {
    return `以下提供兩種付款方式，您可以依方便選擇：\n\n1️⃣ LINE Pay 付款連結\nhttps://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt\n\n2️⃣ 信用卡付款（綠界 ECPay）\nhttps://p.ecpay.com.tw/55FFE71\n\n感謝您的支持與配合 💙`;
  }

  if (/(收衣|收件|來拿|來收)/.test(text)) {
    const addrMatch = text.match(/(.+[路街巷號樓].*)/);
    if (addrMatch) {
      return `好的 😊 我們會去收回的，地址是：${addrMatch[1]}`;
    }
    return "好的 😊 我們會去收回的";
  }

  if (/有.*地址/.test(text)) {
    return "有的，我們都有紀錄的 😊";
  }

  if (/(多久|幾天|時間|要多久)/.test(text)) {
    return "一般時間大約 7-10 天，會依品項不同有所調整哦 ⏳";
  }

  if (/(手推車|嬰兒車|汽座|寶寶汽座|兒童座椅)/.test(text)) {
    return "像手推車、寶寶汽座這些物品，我們都有清潔服務 👍 清潔上需要較多細心處理，我們會盡量做到最好，請放心交給 C.H精緻洗衣 💙\n\n要詳細了解請按 2 🔎";
  }

  if (/(包|鞋|外套|衣服|髒|污漬|洗)/.test(text)) {
    return "這些我們都可以處理，我們會盡量處理，請放心交給 C.H精緻洗衣 💙";
  }

  // --- AI 判斷 ---
  try {
    const res = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "你是 C.H精緻洗衣的專業客服，請用口語化中文回覆，要禮貌、簡短、加上表情符號。不要承諾百分百成功，盡量用『會盡量處理』『請您放心交給我們』。",
        },
        { role: "user", content: text },
      ],
    });

    return res.choices[0].message.content;
  } catch (err) {
    console.error("[OpenAI 錯誤]", err);
    return "抱歉，目前系統忙碌中，請稍後再試 🙏";
  }
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply,
};
