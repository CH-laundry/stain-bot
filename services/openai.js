const { OpenAI } = require("openai");

// ===== OpenAI Client =====
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== 固定連結（可改成 .env）=====
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL     = process.env.LINE_PAY_URL      || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL        = process.env.ECPAY_URL         || "https://p.ecpay.com.tw/55FFE71";

// ===== 小工具 =====
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function normalize(input = "") {
  const fw = "０１２３４５６７８９";
  const hw = "0123456789";
  return input.replace(/[０-９]/g, ch => hw[fw.indexOf(ch)]).trim();
}
function extractTWAddress(text = "") {
  const re = /(台北市|新北市|桃園市|台中市|台南市|高雄市)[^，。\s]{0,30}?(區|市|鎮|鄉)[^，。\s]{0,30}?(路|街|大道|巷|弄)[0-9]{1,4}號(?:之[0-9]{1,2})?(?:[，,\s]*(?:[0-9]{1,2}樓|[0-9]{1,2}F))?/i;
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, "") : "";
}
function reducePercentages(s, delta = 5) {
  return s.replace(/(\d{1,3})\s*%/g, (m, p1) => {
    let num = parseInt(p1, 10);
    if (!isNaN(num) && num > 5) num = Math.max(num - delta, 1);
    return `${num}%`;
  });
}

// ===== 1) 智能污漬分析 =====
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
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

  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `
你是 C.H 精緻洗衣 的專業清潔顧問，請用繁體中文，結構如下：

【分析】
- 物品與污漬狀況（2–3 句，具體描述）
- 材質特性與注意（縮水/掉色/塗層等）
- 污漬可能來源（咖啡/油/墨水…）
- 清潔成功機率（偏保守，% 下調 5，用「有機會改善／可望提升外觀」）
- 品牌/年份/款式推測（可選）
- 結尾：我們會根據材質特性進行適當清潔，確保最佳效果。

【清潔建議】
- 簡短 1–2 句，不提供 DIY 步驟
- 建議交給 C.H 精緻洗衣，避免二次損傷 💙
`,
        },
        { role: "user", content: userContent },
      ],
      temperature: 0.6,
      max_tokens: 900,
    });

    let out = resp.choices?.[0]?.message?.content || "建議交給 C.H 精緻洗衣評估與處理喔 😊";
    return reducePercentages(out, 5);
  } catch (err) {
    console.error("[污漬分析錯誤]", err);
    return "抱歉，目前分析系統忙碌中，請稍後再試 🙏";
  }
}

// ===== 2) 智能客服回覆 =====
async function smartAutoReply(textRaw) {
  if (!textRaw) return null;
  const text = normalize(textRaw);

  // ---- 不回應清單 ----
  if (/^(謝謝|您好|hi|hello|嗨|哈囉|按錯|測試|嗯+|哦+)$/.test(text)) return null;

  // ---- 規則回覆 ----
  if (/付款|結帳|刷卡|支付|line ?pay|信用卡/i.test(text)) {
    return (
      "以下提供兩種付款方式，您可以依方便選擇：\n\n" +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      "感謝您的支持與配合 💙"
    );
  }
  if (/洗壞|壞掉|損壞|負責/.test(text)) {
    return pick([
      "我們作業會非常小心，若真的有狀況會第一時間與您聯繫 😊",
      "放心，我們會盡量避免風險；萬一有狀況，也會和您討論最合適的方式 🙏",
    ]);
  }
  if (/收衣|收件|來收|到府|上門|取件/.test(text)) {
    const addr = extractTWAddress(text);
    return addr ? `好的 😊 我們會安排到府收件\n地址：${addr}` : "好的 😊 我們會安排到府收件";
  }
  if (/有.*地址|地址有沒有|有地址嗎/.test(text)) return "有的，我們都有紀錄的 😊";
  if (/多久|幾天|時間|要多久/.test(text)) return "一般清潔作業時間約 7–10 天 ⏳";
  if (/洗好了嗎|可以拿了嗎|進度|完成了嗎/.test(text)) {
    return `您可以這邊線上查詢進度 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間專人回覆，謝謝您 🙏`;
  }

  // 兒童用品
  if (/手推車|推車|嬰兒車|汽座|安全座椅/.test(text)) {
    return pick([
      "兒童用品我們有拆洗＋深層清潔＋殺菌除味服務，會貼合材質安全，請放心 ✨\n要詳細了解請按 2",
      "像手推車、汽座這類品項我們很熟悉，會細心清潔與除味，請放心交給我們 💙\n要詳細了解請按 2",
    ]);
  }
  if (/窗簾|布簾/.test(text)) {
    return pick([
      "窗簾清潔我們很有經驗，會視材質選擇合適方式，讓它恢復乾淨 👌",
      "大件布簾我們能處理，拆洗後會更清爽，您放心交給我們 💙",
    ]);
  }
  if (/毯子|毛毯|被毯|被子/.test(text)) {
    return pick([
      "毯子類可以清洗，我們會注意材質避免縮水，處理後更柔軟舒適 😊",
      "大件寢具我們常處理，流程兼顧潔淨與保護纖維，請您放心 💙",
    ]);
  }
  if (/鞋|球鞋|運動鞋|皮鞋|靴子/.test(text)) {
    return pick([
      "鞋子我們有專業清潔流程 👟 會依材質調整方式，盡量恢復外觀。",
      "布面與皮革鞋款我們都能處理，也能改善發霉與異味，放心交給我們 💙",
    ]);
  }
  if (/包包|名牌包|手提袋|背包/.test(text)) {
    return pick([
      "包包清潔我們很熟悉，會特別注意皮革與五金，盡量讓外觀更好看 ✨",
      "各種材質的包包我們都能處理，流程上會以安全與外觀改善為主 💙",
    ]);
  }

  // ---- AI fallback ----
  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是 C.H 精緻洗衣的客服，請用口語化中文簡短回答，最後加上表情符號，必須有回覆。" },
        { role: "user", content: text },
      ],
      max_tokens: 300,
    });
    return resp.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("[AI回覆錯誤]", err);
    return "抱歉，目前系統忙碌中 🙏";
  }
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply,
};
