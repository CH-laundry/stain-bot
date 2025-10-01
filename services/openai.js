const { OpenAI } = require("openai");

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 可 .env 覆寫
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";
const LINE_PAY_URL     = process.env.LINE_PAY_URL     || "https://qrcodepay.line.me/qr/payment/ad2fs7S%252BDxiUCtHDInEXe9tnWx7SgIlVX6Ip6PbtXOkp4tXjgCI28920qGq%252B4eIt";
const ECPAY_URL        = process.env.ECPAY_URL        || "https://p.ecpay.com.tw/55FFE71";

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function normalize(s=""){ const fw="０１２３４５６７８９", hw="0123456789"; return (s||"").replace(/[０-９]/g,c=>hw[fw.indexOf(c)]).trim(); }
function isEmojiOrPuncOnly(s=""){ const t=(s||"").trim(); if(!t) return true; const stripped=t.replace(/[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}\s、，。．。！？!?.…~\-—_()*^%$#@＋+／/\\|:;"'<>【】\[\]{}]/gu,""); return stripped.length===0; }

// 僅允許「明顯與洗衣相關」才回應（嚴格門檻）
function maybeLaundryRelated(s="") {
  const t = normalize(s).toLowerCase();
  const kw = [
    // 核心服務
    "洗","清洗","乾洗","送洗","去污","污漬","汙漬","髒","變色","染色","退色","泛黃","發霉",
    "衣","衣服","外套","襯衫","褲","大衣","羽絨","毛衣","皮衣","針織","襯裡","拉鍊","鈕扣",
    "包","包包","名牌包","手提袋","背包","書包","皮革","帆布","麂皮",
    "鞋","球鞋","運動鞋","皮鞋","靴","涼鞋","鞋墊","除臭",
    "窗簾","布簾","遮光簾","地毯","毯子","毛毯","被子","羽絨被",
    // 物流
    "收衣","收件","來收","到府","上門","取件","配送","自取","預約",
    // 咨詢
    "時間","幾天","要多久","進度","洗好了嗎","可以拿了嗎","完成了嗎","查詢","查進度","查詢進度",
    "付款","結帳","信用卡","line pay","支付","匯款",
    "地址","住址","幾樓","樓層",
    // 兒童用品
    "手推車","嬰兒車","汽座","安全座椅",
    // 英文備援
    "laundry","wash","dry clean","stain","pickup","delivery","address","payment","status"
  ];
  return kw.some(k => t.includes(k));
}

function extractTWAddress(text=""){
  const re=/(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^，。\s]{0,30}?(?:區|市|鎮|鄉)[^，。\s]{0,30}?(?:路|街|大道|巷|弄)[0-9]{1,4}號(?:之[0-9]{1,2})?(?:[，,\s]*(?:[0-9]{1,2}樓(?:之[0-9]{1,2})?|[0-9]{1,2}F))?/i;
  const m=text.match(re); return m?m[0].replace(/\s+/g,""):"";
}
function reducePercentages(s,delta=5){ return s.replace(/(\d{1,3})\s*%/g,(m,p1)=>{ let n=parseInt(p1,10); if(!Number.isNaN(n)&&n>5) n=Math.max(n-delta,1); return `${n}%`; }); }

// 1) 智能污漬分析
async function analyzeStainWithAI(imageBuffer, materialInfo="", labelImageBuffer=null){
  const base64Image=imageBuffer.toString('base64');
  const base64Label=labelImageBuffer?labelImageBuffer.toString('base64'):"";

  const userContent=[
    { type:'text', text:'請盡可能詳細分析此物品與污漬，並提供簡短清潔建議。' },
    ...(materialInfo?[{ type:'text', text:`衣物材質：${materialInfo}` }]:[]),
    { type:'image_url', image_url:{ url:`data:image/png;base64,${base64Image}` } }
  ];
  if(base64Label){
    userContent.push({ type:'text', text:'以下是洗滌標籤，僅供參考：' });
    userContent.push({ type:'image_url', image_url:{ url:`data:image/png;base64,${base64Label}` } });
  }

  try{
    const resp=await openaiClient.chat.completions.create({
      model:'gpt-4o',
      messages:[
        { role:'system', content:`
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
` },
        { role:'user', content:userContent }
      ],
      temperature:0.6, max_tokens:1000
    });

    let out=resp.choices?.[0]?.message?.content || '建議交給 C.H 精緻洗衣評估與處理喔 😊';
    out=out.replace(/\*\*/g,'');
    out=reducePercentages(out,5);
    if(!/我們會根據材質特性進行適當清潔，確保最佳效果。/.test(out)){
      out+=`\n我們會根據材質特性進行適當清潔，確保最佳效果。`;
    }
    return out;
  }catch(e){
    console.error('[智能污漬分析錯誤]', e);
    return '抱歉，目前分析系統忙碌中，請稍後再試 🙏';
  }
}

// 2) 智能客服回覆（嚴格門檻 → 規則 → Fallback）
async function smartAutoReply(inputText){
  if(!inputText) return null;
  const text = normalize(inputText);
  if(isEmojiOrPuncOnly(text)) return null;

  // 嚴格門檻：只要不是明顯與洗衣相關 → 不回
  if(!maybeLaundryRelated(text)) return null;

  // 規則：付款
  if (/(付款|結帳|支付|刷卡|line ?pay|信用卡|匯款)/i.test(text)) {
    return (
      "以下提供兩種付款方式，您可以依方便選擇：\n\n" +
      `1️⃣ LINE Pay 付款連結\n${LINE_PAY_URL}\n\n` +
      `2️⃣ 信用卡付款（綠界 ECPay）\n${ECPAY_URL}\n\n` +
      "感謝您的支持與配合 💙"
    );
  }

  // 規則：到府收件（若訊息含地址就複誦）
  if (/(收衣|收件|來收|到府|上門|取件)/.test(text)) {
    const addr = extractTWAddress(text);
    return addr ? `好的 😊 我們會安排到府收件\n地址：${addr}` : "好的 😊 我們會安排到府收件";
  }

  // 規則：是否有地址
  if (/有.*地址|地址有沒有|有地址嗎/.test(text)) return "有的，我們都有紀錄的 😊";

  // 規則：清潔時間
  if (/(多久|幾天|時間|要多久)/.test(text)) {
    return pick([
      "一般清潔作業時間約 7–10 天 ⏳",
      "通常 7–10 天可完成，如遇特殊材質會另行告知，謝謝您 🙏",
      "作業期程多為 7–10 天，若需加速也可再跟我們說明需求 😊"
    ]);
  }

  // 規則：進度查詢
  if (/(洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(text)) {
    return `您可以這邊線上查詢 C.H精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}\n或是營業時間會有專人回覆，謝謝您 🙏`;
  }

  // 規則：兒童用品（汽座/手推車/嬰兒車）→ 指引按 2
  if (/(手推車|推車|嬰兒車|汽座|安全座椅)/.test(text)) {
    return pick([
      "嬰幼兒用品我們也可以清洗；若需要更詳細資訊與估價，請按 2 由專人協助您 😊",
      "這類品項細節較多，建議按 2 由專人說明流程與注意事項，謝謝您 💙",
      "可處理沒問題；如需完整報價與時程，請按 2 讓專人與您聯繫 🙏",
    ]);
  }

  // 規則：洗壞怎麼辦（保守）
  if (/(洗壞|壞掉|損壞|賠偿|賠償|負責)/.test(text)) {
    return pick([
      "理解您在意的地方，我們會把關每一步；若有狀況會第一時間與您聯繫並妥善處理 🙏",
      "我們重視每件物品，如遇特殊情況會主動與您溝通最合適的處理方式，請您放心 💙",
      "作業會盡量避免風險，萬一發生意外也會即時協助後續，保障您的權益 😊",
    ]);
  }

  // 規則：窗簾
  if (/(窗簾|布簾|遮光簾)/.test(text)) {
    return pick([
      "窗簾清潔沒問題，我們會依布料與織法調整流程，兼顧潔淨與版型 👌",
      "大件布簾常處理，會先評估縮水與掉色風險，再安排合適方式 😊",
      "若有特殊塗層會先做小範圍測試，處理後更清爽；可先拍照讓我們初評 💙",
      "會注意尺寸穩定性與垂墜感，處理完成整體會更俐落 ✨",
    ]);
  }

  // 規則：毯子/被毯
  if (/(毯子|毛毯|被毯|被子|羽絨被)/.test(text)) {
    return pick([
      "毯被清潔 OK，我們會兼顧纖維蓬鬆度與縮水風險，觸感與潔淨度可望提升 😊",
      "寢具件我們很熟悉，流程會保護纖維結構，洗完更舒適 💙",
      "羽絨類會更溫和處理並充分烘透，維持蓬鬆與乾爽 ✨",
      "可先提供尺寸與材質，估價更精準；我們再安排合適流程 👍",
    ]);
  }

  // 規則：鞋子
  if (/(鞋|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(text)) {
    return pick([
      "鞋類可處理，我們會依材質（布面/皮革/麂皮）調整方式，盡量恢復外觀 👟",
      "發霉、異味或黃斑多能改善；會先做不顯眼處測試再進行 😊",
      "皮革鞋會注意上油護理，布面鞋會加強清潔與定型，細節我們會把關 💙",
      "鞋底與縫線易藏污，我們會細清與除味，穿著感會更好 ✨",
    ]);
  }

  // 規則：包包
  if (/(包包|名牌包|手提袋|背包|書包)/.test(text)) {
    return pick([
      "包款我們熟悉，會注意皮革塗層與五金，做針對性清潔與養護 ✨",
      "精品包會更溫和處理並做色牢度測試，可望改善可見髒污 💙",
      "帆布/尼龍/皮革不同，我們會分區處理避免擴散與色差；可先拍照讓我們初評 😊",
      "內襯、肩帶也會整理，整體觀感會提升不少 👍",
    ]);
  }

  // 規則：衣物污漬/泛黃/縮水/染色
  if (/(污漬|髒污|泛黃|黃斑|染色|掉色|縮水|變形)/.test(text)) {
    return pick([
      "會先評估材質與色牢度，再選擇溫和方式；可望提升外觀與清新度 😊",
      "依成因（油/汗/色料等）分段處理，盡量降低對材質的影響 💙",
      "若為舊氧化或嚴重染色，改善幅度會較保守，我們也會如實說明與您溝通 ✨",
      "處理前會做小面積測試，安全再進行；若方便可先拍照提供我們初評 👍",
    ]);
  }

  // 一般「可不可以洗」
  if (/(可以洗|能不能洗|可不可以洗|能洗|可清洗|能處理|可處理)/.test(text) &&
      /(衣|外套|羽絨|襯衫|大衣|褲)/.test(text)) {
    return pick([
      "沒問題，多數衣物都可處理；會依材質調整流程並說明預期改善幅度 😊",
      "可清洗，細節會於現場再確認；過程會盡量保護纖維結構 💙",
      "會先做材質測試與局部處理，再決定整體流程，降低風險 ✨",
    ]);
  }

  // Fallback：仍屬洗衣主題，但沒命中規則 → 由 GPT 生成
  try{
    const resp=await openaiClient.chat.completions.create({
      model:'gpt-4',
      messages:[
        { role:'system', content:'你是「C.H 精緻洗衣」客服。用自然口語繁中、禮貌專業、避免絕對保證；1～3 句即可，語氣多樣、別重複。' },
        { role:'user', content:text }
      ],
      temperature:0.9, max_tokens:220
    });
    let out = resp.choices?.[0]?.message?.content?.trim();
    if(!out) out = '我們已收到您的訊息，會再與您確認細節，謝謝您 😊';
    out = out.replace(/請放心交給.*?精緻洗衣/g, '我們會妥善處理與說明，謝謝您');
    return out;
  }catch(e){
    console.error('[AI 回覆錯誤]', e);
    return '抱歉，目前系統忙碌中 🙏';
  }
}

module.exports = { analyzeStainWithAI, smartAutoReply };
