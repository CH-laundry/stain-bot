// services/openai.js
const { OpenAI } = require("openai");
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 固定連結（可 .env 覆寫）
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL = process.env.LINE_PAY_URL || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL = process.env.ECPAY_URL || "https://p.ecpay.com.tw/55FFE71";
const BUSINESS_HOURS_TEXT_ENV = process.env.BUSINESS_HOURS_TEXT || "";

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

// ===== 污漬智能分析 =====
// ▼ 直接覆蓋原本的 analyzeStainWithAI 即可（維持 gpt-4o）
async function analyzeStainWithAI(imageBuffer, materialInfo = "", labelImageBuffer = null) {
  const base64Image = imageBuffer.toString("base64");
  const base64Label = labelImageBuffer ? labelImageBuffer.toString("base64") : "";

  const userContent = [
    { type: "text", text: "請就圖片進行專業清潔分析，並嚴格品牌辨識。" },
    ...(materialInfo ? [{ type: "text", text: `衣物材質：${materialInfo}` }] : []),
    { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
  ];
  if (base64Label) {
    userContent.push({ type: "text", text: "以下是洗滌標籤，僅供參考：" });
    userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64Label}` } });
  }

  // 小工具：把百分比保守下修 5%
  const softenPercent = (s) =>
    s.replace(/(\d{1,3})\s*%/g, (m, p1) => {
      let n = parseInt(p1, 10);
      if (!Number.isNaN(n) && n > 5) n = Math.max(n - 5, 1);
      return `${n}%`;
    });

  // 小工具：套入品牌段落（若原文沒有就插入）
  const upsertBrandSection = (report, brandBlock) => {
    if (/品牌推測/.test(report)) {
      return report.replace(/(^|\n)5\)\s*【?品牌推測】?[\s\S]*?(?=\n6\)|\n【清潔建議】|$)/, `\n5) 品牌推測\n${brandBlock}\n`);
    }
    return report.replace(/(清潔成功機率[\s\S]*?\n)/, `$1\n5) 品牌推測\n${brandBlock}\n`);
  };

  // ---------- 階段 1：完整分析（較低溫度，要求給依據但不強猜） ----------
  let fullReport = "建議交給 C.H 精緻洗衣評估與處理喔 😊";
  try {
    const respFull = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      top_p: 0.8,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `
你是 C.H 精緻洗衣 的專業清潔顧問。**不得把不確定當作確定**。先觀察圖樣、皮革壓紋、五金、手把與版型，再做品牌推測；推測一定要附「依據」，信心要保守。

【品牌速查要點（嚴格）】
- LV Monogram：深/淺棕底＋反覆「LV」與三種四瓣花，等距排列；常見金色五金、棕色手把。
- LV Damier：棋盤格（兩色小方格交錯），Ebene 棕色/Graphite 黑灰。
- CHANEL：菱格、雙C扣、鍊帶皮穿金。
- Hermès：Birkin/Kelly 鎖扣、Togo/Epsom 紋理、素雅配色。
- Gucci：雙G（GG Supreme）、綠紅綠織帶。
- Dior：Oblique 斜紋「Dior」字樣。

【輸出格式（逐點）】
1) 物品與污漬狀況：2–4 句（位置/範圍/顏色/滲入深度）
2) 材質特性與注意：縮水/掉色/塗層/皮革護理等
3) 污漬可能來源：油汙、汗漬、化妝品、墨水、咖啡…
4) 清潔成功機率：用「有機會改善／可望提升外觀」等保守字眼，可附百分比
5) 【品牌推測】可能為：品牌／系列（信心 X%）；下一行「依據：…」。若不確定→「品牌推測：不明（依據不足）」。
6) 款式特徵：手把形狀、托特/波士頓/斜背、五金形制等
7) 結尾：我們會根據材質特性進行適當清潔，確保最佳效果。

【清潔建議（另段）】
- 僅 1–2 句，不給 DIY 比例；避免「保證／一定」。
- 可加：「若擔心，建議交給 C.H 精緻洗衣專業處理，避免自行操作造成二次損傷 💙」。
          `.trim(),
        },
        { role: "user", content: userContent },
      ],
    });
    fullReport = respFull?.choices?.[0]?.message?.content || fullReport;
  } catch (e) {
    console.error("[分析階段1錯誤]", e);
  }

  // ---------- 階段 2：品牌「僅品牌」複審（JSON 輸出，方便程式判斷） ----------
  let brandJSON = null;
  try {
    const respBrand = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2, // 更嚴謹
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `
你只做「品牌複審」。請**務必輸出 JSON**，格式如下：
{"brand":"LV|Chanel|Hermes|Gucci|Dior|Unknown","series":"文字或空字串","confidence":0-100,"basis":["觀察到的花紋/五金/版型等依據…"]}

規則：
- 只在**圖樣與細節明確吻合**時才給 70 分以上；模糊或遮擋→小於 60。
- LV 判斷重點：Monogram 四瓣花＋LV 交疊等距／Damier 棋盤格；搭配金色五金、棕色手把常見托特。
- 不確定就 brand=Unknown，confidence 不得超過 60。
`.trim(),
        },
        {
          role: "user",
          content: [
            { type: "text", text: "請對同一張圖片進行品牌複審，只回答 JSON：" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
          ],
        },
      ],
    });
    const t = respBrand?.choices?.[0]?.message?.content || "";
    // 嘗試從文字中抓 JSON
    const match = t.match(/\{[\s\S]*\}$/);
    if (match) brandJSON = JSON.parse(match[0]);
  } catch (e) {
    console.error("[分析階段2錯誤]", e);
  }

  // ---------- 合併：若複審信心高（≥70）→ 覆蓋品牌段落 ----------
  try {
    if (brandJSON && typeof brandJSON === "object") {
      const b = (brandJSON.brand || "").toLowerCase();
      const conf = Number(brandJSON.confidence || 0);
      const series = brandJSON.series || "";
      const basisArr = Array.isArray(brandJSON.basis) ? brandJSON.basis : [];
      const basisText = basisArr.length ? `依據：${basisArr.join("；")}` : "依據：花紋/五金/版型等整體觀察";

      if (conf >= 70 && b !== "unknown") {
        // 高信心：覆蓋
        const brandName =
          b === "lv" ? "Louis Vuitton"
          : b === "chanel" ? "CHANEL"
          : b === "hermes" ? "Hermès"
          : b === "gucci" ? "Gucci"
          : b === "dior" ? "Dior"
          : brandJSON.brand;
        const brandBlock = `可能為：${brandName}${series ? `／${series}` : ""}（信心 ${Math.min(99, conf)}%）\n${basisText}`;
        fullReport = upsertBrandSection(fullReport, brandBlock);
      } else if (!/品牌推測/.test(fullReport)) {
        // 低信心且原文沒有 → 補「依據不足」
        fullReport = upsertBrandSection(fullReport, `品牌推測：不明（依據不足）`);
      }
    } else if (!/品牌推測/.test(fullReport)) {
      fullReport = upsertBrandSection(fullReport, `品牌推測：不明（依據不足）`);
    }
  } catch (e) {
    console.error("[品牌合併錯誤]", e);
  }

  // ---------- 後處理：下修百分比 + 固定結尾 ----------
  let out = (fullReport || "").replace(/\*\*/g, "");
  out = softenPercent(out);
  if (!/我們會根據材質特性進行適當清潔，確保最佳效果。/.test(out)) {
    out += `\n我們會根據材質特性進行適當清潔，確保最佳效果。`;
  }
  return out;
}

    catch (e) {
    console.error("[智能污漬分析錯誤]", e);
    return "抱歉，目前分析系統忙碌中，請稍後再試 🙏";
  }
}

// ===== 智能客服回覆（規則優先 → Fallback）=====
async function smartAutoReply(inputText) {
  if (!inputText) return null;
  const text = normalize(inputText);
  if (isEmojiOrPuncOnly(text)) return null;
  if (!maybeLaundryRelated(text)) return null;

  // 想送洗（不問地址與時間，直接答應收回）
if (/(送洗|想\s*送洗|想洗衣|要洗衣|我要送洗|我想送洗|我想洗衣服|想送洗衣服)/.test(text)) {
  return "好的 😊 沒問題，我們會過去收回的";
}

  // 收件 / 收衣（含地址複誦）
  if (/(收衣|收件|來收|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    return addr ? `好的 😊 我們會去收回，地址是：${addr}` : "好的 😊 我們會去收回的";
  }

  // 付款
  if (/(付款|結帳|支付|刷卡|line ?pay|信用卡|匯款)/i.test(text)) {
    return (
      "以下提供兩種付款方式，您可以依方便選擇：\n\n" +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      "感謝您的支持與配合 💙"
    );
  }

  // 優惠 / 活動
  if (/(優惠|活動|折扣|促銷|特價|有沒有.*活動)/.test(text)) {
    return "您好，我們的優惠活動會不定期在官方網站及社群媒體上發布，建議您可以追蹤我們的社群平台以免錯過任何好康資訊。";
  }

  // 清潔時間（7–10 天）
  if (/(多久|幾天|時間|要多久)/.test(text)) {
    return pick([
      "一般清潔作業時間約 7–10 天 ⏳",
      "通常 7–10 天可完成，如遇特殊材質會另行告知，謝謝您 🙏",
      "作業期程多為 7–10 天，若需加速也可再跟我們說明需求 😊",
    ]);
  }

  // 營業時間 / 是否有開（週六固定公休）
  if (/(幾點開|幾點關|營業|開門|關門|打烊|今天有開|今日有開|有沒有開)/.test(text)) {
    if (BUSINESS_HOURS_TEXT_ENV) return BUSINESS_HOURS_TEXT_ENV;
    const isSaturday = new Date().getDay() === 6; // 0=週日, 6=週六
    if (isSaturday) return "今天是週六固定公休，明日週日有營業的 😊";
    return "營業時間：週一至週日 10:30–20:00（週六公休）。如需到府收件可跟我們說喔，謝謝您 😊";
  }

  // 進度查詢
  if (/(洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(text)) {
    return `您可以這邊線上查詢 C.H精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間會有專人回覆，謝謝您 🙏`;
  }
  // 7) 一起洗
  if (/一起洗|一起處理|全部洗/.test(text)) {
    return "可以的 😊 請放心交給 C.H 精緻洗衣 💙";
  }

  // 8) 棉被 / 羽絨被
  if (/(棉被|被子|羽絨被)/.test(text)) {
    if (/怕|擔心|壓壞|羽絨/.test(text)) {
      return "不會的 🪶 我們會注意保護羽絨結構，讓它保持蓬鬆度 ✨";
    }
    return "可以的 😊 我們會兼顧蓬鬆度與乾爽度，處理後會更舒適 💙";
  }

  // 9) 鞋子
  if (/(鞋子|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text)) {
    if (/不要再出意外|小心|上次|擔心|希望鞋子不要再出意外/.test(text)) {
      return "沒問題 👟 我們會額外留意細節，請您特別放心 💙";
    }
    return "可以的 👟 我們會特別注意的，請放心交給 C.H 精緻洗衣 💙";
  }

  // 10) 包包
  if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    return pick([
      "您好，包包我們有專業處理 💼 會依材質調整方式，像皮革會注意保養護理，布面則加強清潔與定型，請您放心交給 C.H 精緻洗衣 😊",
      "包包是可以處理的 👍 我們會先檢視材質狀況，盡量在清潔同時保護原有外觀 💙",
      "可以的喔 💼 包包清潔會依布料或皮革狀況分別處理，細節我們都會把關 ✨",
    ]);
  }

  // 嬰幼兒用品（汽座/手推車/嬰兒車）→ 按 2
  if (/(手推車|推車|嬰兒車|汽座|安全座椅)/.test(text)) {
    return pick([
      "可以清潔；細節較多，若需完整報價與時程，請按 2 由專人協助您 😊",
      "我們能處理這類品項；想了解流程與注意事項，請按 2，謝謝您 💙",
      "可處理沒問題；如需更詳細說明，請按 2 讓專人與您聯繫 🙏",
    ]);
  }

  // 包包
  if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    return pick([
      "您好，包包我們有專業處理 💼 會依材質調整方式，像皮革會注意保養護理，布面則加強清潔與定型，請您放心交給 C.H 精緻洗衣 😊",
      "包包是可以處理的 👍 我們會先檢視材質狀況，盡量在清潔同時保護原有外觀，有需要也能加強整形或護理 💙",
      "可以的喔 💼 包包清潔會依布料或皮革狀況分別處理，細節我們都會把關，請放心交給 C.H 精緻洗衣 ✨",
    ]);
  }

  // 鞋子
  if (/(有.*洗.*鞋|有洗鞋|鞋(子)?可以洗|洗鞋(服務)?)/i.test(text) || /(鞋|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text)) {
    return pick([
      "可以清潔鞋子，我們會依材質（布面/皮革/麂皮）調整方式，盡量恢復外觀 👟",
      "鞋子可處理；發霉、異味或黃斑多能改善，會先做不顯眼處測試再進行 😊",
      "可清潔；皮革鞋會注意上油護理，布面鞋會加強清潔與定型 💙",
      "可以清洗；鞋底與縫線易藏污，我們會細清與除味，穿著感更好 ✨",
    ]);
  }

  // 地毯
  if (/(地毯|地墊)/.test(text)) {
    return pick([
      "地毯可以清潔，我們會分區與深層清潔，兼顧纖維與色澤，整體觀感可望提升 ✨",
      "地毯可處理；會先做局部測試再進行深層清潔與除味，讓居家更清爽 😊",
      "可以清潔地毯；針對藏汙位置與邊緣收邊會特別留意，完成後更舒適 👍",
    ]);
  }

  // 棉被/被子
  if (/(棉被|被子|羽絨被)/.test(text)) {
    return pick([
      "棉被可以清潔；我們會兼顧蓬鬆度與乾爽度，睡感可望更舒適 😊",
      "被子可處理；流程會保護纖維結構並充分烘透，使用上更衛生 💙",
      "可以清洗棉被；完成後會更乾淨清新，收納也更安心 ✨",
    ]);
  }

  // 帽子
  if (/(帽子|毛帽|棒球帽|鴨舌帽|禮帽)/.test(text)) {
    return pick([
      "可以清潔帽子，我們會依材質（棉/毛料/皮革/混紡）調整方式，並留意帽型不變形 😊",
      "帽子可處理；會先做小範圍測試再清潔，兼顧外觀與版型 ✨",
      "可以洗的；我們會針對汗線與邊緣髒汙分區處理，盡量提升整體觀感 💙",
    ]);
  }

  // 窗簾
  if (/(窗簾|布簾|遮光簾)/.test(text)) {
    return pick([
      "可以清潔窗簾，我們會依布料與織法調整流程，兼顧潔淨與版型 👌",
      "窗簾可處理；會先評估縮水與掉色風險，再安排合適方式 😊",
      "可清潔；若有特殊塗層會先做小範圍測試，處理後更清爽 💙",
      "窗簾可以清洗，會注意尺寸穩定與垂墜感，完成後更俐落 ✨",
    ]);
  }

  // 污漬/泛黃/染色/縮水（不給保證）
  if (/(污漬|髒污|泛黃|黃斑|染色|掉色|縮水|變形)/.test(text)) {
    return pick([
      "這些情況我們可以處理；會依狀況調整方式，有機會改善外觀與清新度 😊",
      "可處理；不同成因會採取不同方法，但改善幅度需視程度而定，我們會如實說明 💙",
      "我們會盡量處理；舊氧化或嚴重染色效果會較保守，會先做小面積測試 ✨",
      "可以處理；會先評估安全性再進行，降低對材質的負擔 👍",
    ]);
  }

  // 一般衣物能不能洗
  if (/(可以洗|能不能洗|可不可以洗|能洗|可清洗|能處理|可處理)/.test(text) &&
      /(衣|外套|羽絨|襯衫|大衣|褲)/.test(text)) {
    return pick([
      "可以清洗，多數衣物都沒問題；會依材質調整流程並說明預期改善幅度 😊",
      "可清潔；細節會於現場再確認，過程會盡量保護纖維結構 💙",
      "可以處理；會先做材質測試與局部處理，再決定整體流程，降低風險 ✨",
    ]);
  }

  // —— Fallback ——（仍屬洗衣主題）
  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是「C.H 精緻洗衣」客服。用自然口語繁中、禮貌專業、避免絕對保證；1～3 句即可，語氣多樣、別重複。" },
        { role: "user", content: text },
      ],
      temperature: 0.85,
      max_tokens: 220,
    });
    let out = resp?.choices?.[0]?.message?.content?.trim();
    if (!out) out = "我們已收到您的訊息，會再與您確認細節，謝謝您 😊";
    out = out.replace(/保證|一定|絕對/gi, "").replace(/請放心交給.*?精緻洗衣/g, "我們會妥善處理與說明，謝謝您");
    return out;
  } catch (e) {
    console.error("[AI 回覆錯誤]", e);
    return "抱歉，目前系統忙碌中 🙏";
  }
}

module.exports = { analyzeStainWithAI, smartAutoReply };
