// services/openai.js
const { OpenAI } = require("openai");

// ===== OpenAI Client =====
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== 固定連結（可改 .env）=====
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL     = process.env.LINE_PAY_URL      || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL        = process.env.ECPAY_URL         || "https://p.ecpay.com.tw/55FFE71";

// ===== 小工具 =====
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function normalize(s = "") {
  const fw = "０１２３４５６７８９";
  const hw = "0123456789";
  return (s || "").replace(/[０-９]/g, c => hw[fw.indexOf(c)]).trim();
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
    "洗","清洗","乾洗","送洗","去污","污漬","汙漬","髒","變色","染色","退色","泛黃","發霉",
    "衣","衣服","外套","襯衫","褲","大衣","羽絨","毛衣","皮衣","針織","襯裡","拉鍊","鈕扣",
    "包","包包","名牌包","手提袋","背包","書包","皮革","帆布","麂皮",
    "鞋","球鞋","運動鞋","皮鞋","靴","涼鞋","鞋墊","除臭",
    "窗簾","布簾","遮光簾","地毯","毯子","毛毯","被子","羽絨被",
    "收衣","收件","來收","到府","上門","取件","配送","自取","預約",
    "付款","結帳","信用卡","line pay","支付","匯款",
    "進度","好了嗎","洗好了嗎","可以拿了嗎","完成了嗎","查詢","查進度","查詢進度",
    "地址","住址","幾樓","樓層","時間","幾天","要多久",
    "手推車","嬰兒車","汽座","安全座椅",
    "laundry","wash","dry clean","stain","pickup","delivery","address","payment","status"
  ];
  return kw.some(k => t.includes(k));
}
function extractTWAddress(text = "") {
  const re =
    /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,30}?(?:區|市|鎮|鄉)[^，。\s]{0,30}?(?:路|街|大道|巷|弄)[0-9]{1,4}號(?:之[0-9]{1,2})?(?:[，,\s]*(?:[0-9]{1,2}樓(?:之[0-9]{1,2})?|[0-9]{1,2}F))?/i;
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, "") : "";
}
function reducePercentages(s, delta = 5) {
  return s.replace(/(\d{1,3})\s*%/g, (m, p1) => {
    let n = parseInt(p1, 10);
    if (!Number.isNaN(n) && n > 5) n = Math.max(n - delta, 1);
    return `${n}%`;
  });
}

// ===== 輕量 AI 分類器（不確定時判斷是否洗衣相關）=====
async function classifyLaundryIntent(text) {
  try {
    const r = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "判定訊息是否與『洗衣/清潔服務（衣物/包鞋/窗簾/毯子/收送/付款/進度/地址/時間）』相關。只回答 related / unrelated / uncertain。" },
        { role: "user", content: text }
      ],
      max_tokens: 3,
      temperature: 0
    });
    const ans = (r.choices?.[0]?.message?.content || "").toLowerCase().trim();
    if (ans.includes("related")) return "related";
    if (ans.includes("unrelated")) return "unrelated";
    return "uncertain";
  } catch {
    return "uncertain";
  }
}

// ============ 1) 智能污漬分析（按 1 → 上傳圖片；機率自動 -5%） ============
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
你是 C.H 精緻洗衣 的專業清潔顧問，請用口語化繁體中文，結構如下：

【分析】
- 物品與污漬狀況（2–4 句：位置、範圍、顏色、滲入深度）
- 材質特性與注意（縮水/掉色/塗層/皮革護理等）
- 污漬可能來源（油/汗/化妝/墨水/咖啡…）
- 清潔成功機率（可附百分比，但偏保守；用「有機會改善／可望提升外觀」）
- 品牌/年份/款式推測（如能據花紋/五金/版型推測，請用「可能為／推測為」）
- 結尾：我們會根據材質特性進行適當清潔，確保最佳效果。

【清潔建議】
- 只給 1–2 句簡短建議（避免 DIY 步驟或藥劑比例）
- 可說「若擔心，建議交給 C.H 精緻洗衣專業處理，避免自行操作造成二次損傷 💙」
`,
        },
        { role: "user", content: userContent },
      ],
      temperature: 0.6,
      max_tokens: 1000,
    });

    let out = resp.choices?.[0]?.message?.content || "建議交給 C.H 精緻洗衣評估與處理喔 😊";
    out = out.replace(/\*\*/g, "");
    out = reducePercentages(out, 5);
    if (!/我們會根據材質特性進行適當清潔，確保最佳效果。/.test(out)) {
      out += `\n我們會根據材質特性進行適當清潔，確保最佳效果。`;
    }
    return out;
  } catch (err) {
    console.error("[智能污漬分析錯誤]", err);
    return "抱歉，目前分析系統忙碌中，請稍後再試 🙏";
  }
}

// ============ 2) 智能客服回覆（寬鬆守門 → 規則（多樣化）→ Fallback AI） ============
async function smartAutoReply(inputText) {
  if (!inputText) return null;
  const text = normalize(inputText);

  // 0) 明顯無內容 → 不回
  if (isEmojiOrPuncOnly(text)) return null;

  // 1) 寬鬆判斷：若不明顯，再丟輕量分類器
  let intent = "related";
  if (!maybeLaundryRelated(text)) {
    intent = await classifyLaundryIntent(text);
    if (intent === "unrelated") return null; // 明確不相關 → 不回
  }

  // 2) 規則優先（多樣化回答，不制式）
  // 付款（只在用字明確時提供）
  if (/(付款|結帳|支付|刷卡|line ?pay|信用卡)/i.test(text)) {
    return (
      "以下提供兩種付款方式，您可以依方便選擇：\n\n" +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      "感謝您的支持與配合 💙"
    );
  }

  // 到府收件（含地址複誦）
  if (/(收衣|收件|來收|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    return addr ? `好的 😊 我們會安排到府收件\n地址：${addr}` : "好的 😊 我們會安排到府收件";
  }

  // 問是否有地址
  if (/有.*地址|地址有沒有|有地址嗎/.test(text)) {
    return "有的，我們都有紀錄的 😊";
  }

  // 清潔時間
  if (/(多久|幾天|時間|要多久)/.test(text)) {
    return "一般清潔作業時間約 7–10 天 ⏳";
  }

  // 進度查詢（加上你要的句子）
  if (/(洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(text)) {
    return `您可以這邊線上查詢 C.H精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間會有專人回覆，謝謝您 🙏`;
  }

  // 兒童用品（汽座 / 手推車 / 嬰兒車）→ 僅指引「按 2」
  if (/(手推車|推車|嬰兒車|汽座|安全座椅)/.test(text)) {
    return pick([
      "兒童用品屬於特別品項，需再確認細節；要了解完整流程與報價請按 2，由專人協助您 😊",
      "為確保安全與品質，這類品項改由人工專員說明與預約；請按 2 進一步了解，謝謝您 💙",
      "相關細節較多，我們會由專人一對一說明；若要了解服務與價格，請按 2 🙏",
    ]);
  }

  // 洗壞怎麼辦（保守且多樣）
  if (/(洗壞|壞掉|損壞|賠偿|賠償|負責)/.test(text)) {
    return pick([
      "理解您的擔心，我們作業會非常小心；若真的有狀況會第一時間與您聯繫並妥善處理 🙏",
      "我們重視每件物品，若不幸發生問題，會依流程與您溝通最合適的處理方式與補救方案 😊",
      "我們會把關每一步，萬一發生意外，也一定主動聯絡與協助後續，請您放心 💙",
    ]);
  }

  // 窗簾 / 布簾
  if (/(窗簾|布簾|遮光簾)/.test(text)) {
    return pick([
      "窗簾清潔沒有問題，我們會依布料性質調整流程，兼顧潔淨與版型 👌",
      "大件布簾我們很熟悉，會先評估縮水與掉色風險，再安排合適方式處理 😊",
      "窗簾處理完成會更清爽，若有特殊塗層也會先測試再進行，您可以放心交給我們 💙",
      "不同織法的窗簾需要不同處理，我們會細心清潔並注意尺寸穩定性 ✨",
      "可先拍照給我們初步評估，實品到店會再二次確認材質後進行處理 👍",
    ]);
  }

  // 毯子 / 被毯
  if (/(毯子|毛毯|被毯|被子|羽絨被)/.test(text)) {
    return pick([
      "毯被清潔 OK，我們會注意纖維蓬鬆度與縮水風險，改善觸感與潔淨度 😊",
      "大件寢具我們常處理，流程會兼顧清潔與保護纖維結構，洗完更舒適 💙",
      "若是羽絨內材會更溫和處理並充分烘透，維持蓬鬆與乾爽 ✨",
      "可以先告訴我們尺寸與材質，估價會更準確，我們再安排合適流程 👍",
      "有毛球或異味都能改善，交給我們處理就好～",
    ]);
  }

  // 鞋子
  if (/(鞋|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text)) {
    return pick([
      "鞋類我們有專業流程，會依材質（布面/皮革/麂皮）調整方式，盡量恢復外觀 👟",
      "發霉、異味或黃斑都能處理到一定程度，會先做不顯眼處測試再進行 😊",
      "皮革鞋會注意上油與護理，布面鞋會加強清潔與定型，細節我們會把關 💙",
      "鞋底與車縫處容易藏污，我們會細清與除味，改善穿著感 ✨",
      "可以先拍鞋面近照給我們，會更快評估處理重點與時程 👍",
    ]);
  }

  // 包包
  if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    return pick([
      "包款我們很熟悉，會注意皮革、塗層與五金，針對性清潔與養護 ✨",
      "若是精品包會更溫和處理並做色牢度測試，盡量改善可見髒污 💙",
      "帆布/尼龍/皮革材質不同，我們會分區處理，避免擴散與色差 😊",
      "建議先拍正面/側面/污點近照，估價與期望可更精準 👍",
      "內襯與肩帶也會一起整理，整體觀感會提升不少～",
    ]);
  }

  // 衣物污漬/泛黃/縮水/染色
  if (/(污漬|髒污|泛黃|黃斑|染色|掉色|縮水|變形)/.test(text)) {
    return pick([
      "會先評估材質與色牢度，再選擇溫和方式處理；可望改善外觀與清新度 😊",
      "依污點成因不同（油/汗/色料）做分段處理，盡量降低對材質的影響 💙",
      "若屬舊氧化或嚴重染色，改善幅度會較保守，我們也會如實說明與溝通 ✨",
      "處理前會先做不顯眼處測試，確定安全再進行，請您放心 👍",
      "可以先拍照給我們，初步建議會更明確；到店會再二次確認～",
    ]);
  }

  // 一般能否清洗（衣物/外套/羽絨）
  if (/(可以洗|能不能洗|可不可以洗|能洗|可清洗|能處理|可處理)/.test(text) && /(衣|外套|羽絨|襯衫|大衣|褲)/.test(text)) {
    return pick([
      "沒問題，我們會依材質調整流程並說明預期改善幅度，您可以放心 😊",
      "多數衣物都能處理，細節會現場再確認，過程會盡量保護纖維結構 💙",
      "會先做材質測試與局部處理，再決定整體流程，降低風險 ✨",
      "若有特別在意的部位可以先告訴我們，我們會重點加強 👍",
    ]);
  }

  // 3) Fallback：交給 GPT 生成（要求自然、多樣、必回）
  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "你是「C.H 精緻洗衣」的客服。用自然口語繁中、禮貌專業、避免絕對保證。給 1～3 句即可，語氣多樣，避免重複口頭禪。",
        },
        { role: "user", content: text },
      ],
      temperature: 0.8,
      max_tokens: 220,
    });
    const out = resp.choices?.[0]?.message?.content?.trim();
    return out || "目前資訊收到，我們會再為您確認細節，謝謝您 😊";
  } catch (err) {
    console.error("[AI 回覆錯誤]", err);
    return "抱歉，目前系統忙碌中 🙏";
  }
}

module.exports = {
  analyzeStainWithAI,
  smartAutoReply,
};
