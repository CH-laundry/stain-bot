// services/message.js
const { Client } = require('@line/bot-sdk');
const { analyzeStainWithAI, smartAutoReply, createECPayPaymentLink } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');
const fetch = require('node-fetch');
const { isOneKey, isTwoKey } = require('./utils');



// LINE client
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 固定忽略(選單文字等)
const ignoredKeywords = [
  '常見問題', '服務價目&儲值優惠', '到府收送', '店面地址&營業時間',
  '付款方式', '寶寶汽座&手推車', '顧客須知', '智能污漬分析'
];



// 文字清理：去 emoji、全形轉半形、壓縮多餘空白
function cleanText(s = '') {
  const toHalf = x =>
    x
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全形轉半形
      .replace(/\u3000/g, ' '); // 全形空白轉半形
  return toHalf(s)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // 移除 emoji
    .replace(/\s+/g, ' ') // 合併多個空白
    .trim();
}
// 通用正規化：NFKC → 清理 → 小寫
function normalize(text = '') {
  const src = String(text ?? '');
  // 若環境支援 String.prototype.normalize，先做 Unicode 正規化（處理全半形、符號一致性）
  const nfkc = typeof src.normalize === 'function' ? src.normalize('NFKC') : src;
  // 你的 cleanText 會做：全形轉半形、移除 emoji、壓縮空白、trim
  return cleanText(nfkc).toLowerCase();
}


// 安全取得使用者資料，若失敗不報錯
async function safeGetProfile(userId) {
  try {
    return await client.getProfile(userId);
  } catch (err) {
    logger.logError('取得使用者資料失敗', err, userId);
    return { displayName: '' }; // 傳回空物件避免整段報錯
  }
}

function isEmojiOrPuncOnly(s = '') {
  const t = (s || '').trim();
  if (!t) return true;
  const stripped = t.replace(
    /[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}\s、，。．。！？!?.…~\-—_()*^%$#@＋+／/\\|:;"'<>【】\[\]{}]/gu,
    ''
  );
  return stripped.length === 0;
}
function isSmallTalk(t = '') {
  const s = normalize(t).toLowerCase();
  const patterns = [
    /^謝謝(你|您)?$/, /^感謝(你|您)?$/, /^辛苦了$/, /^抱歉$/, /^不好意思$/,
    /^沒關係$/, /^不會$/, /^好的?$/, /^ok$|^okay$/i, /^收到$/, /^了解$/, /^知道了?$/,
    /^嗯+$|^喔+$|^哦+$|^啊+$|^欸+$/i, /^哈哈+$/i, /^呵呵+$/i, /^哈囉$|^hello$|^hi$|^嗨$/i,
    /^在嗎\??$/, /^在\??$/, /^有人在嗎\??$/, /^有人嗎\??$/, /^不是$/,
    /^早安$|^午安$|^晚安$/, /^測試$/, /^test$/i
  ];
  return patterns.some(re => re.test(s));
}
const isPhoneNumberOnly = (t='') => /^09\d{8}$/.test(t.replace(/\s|-/g,'')) || /^0\d{1,3}\d{6,8}$/.test(t.replace(/\s|-/g,'')) || /^\+886\d{9}$/.test(t.replace(/\s|-/g,''));
const isUrlOnly = (t='') => /^(https?:\/\/|www\.)\S+$/i.test((t||'').trim());
function isClearlyUnrelatedTopic(t='') {
  const s = (t||'').toLowerCase();
  const weather = /(天氣|下雨|出太陽|晴天|颱風|好熱|很熱|好冷|很冷|溫度|涼|熱)/;
  const chitchat = /(在幹嘛|在忙嗎|聊聊|聊天|怎麼樣|最近如何|在不在)/;
  return weather.test(s) || chitchat.test(s);
}
function maybeLaundryRelated(s='') {
  const t = normalize(s).toLowerCase();
  const kw = [
    '洗','清洗','乾洗','去污','污漬','汙漬','髒','變色','染色','退色','泛黃','發霉',
    '衣','衣服','外套','襯衫','褲','大衣','羽絨','毛衣','皮衣','針織','拉鍊','鈕扣',
    '包','包包','名牌包','手提袋','背包','書包','皮革','帆布','麂皮',
    '鞋','球鞋','運動鞋','皮鞋','靴','涼鞋','鞋墊','除臭',
    '窗簾','布簾','遮光簾','地毯','地墊','毯子','毛毯','被子','羽絨被','棉被',
    '帽子','毛帽','棒球帽','鴨舌帽','禮帽',
    '收衣','收件','到府','上門','取件','配送','預約',
    '時間','幾天','要多久','進度','洗好了嗎','可以拿了嗎','完成了嗎','查進度',
    '付款','結帳','信用卡','line pay','支付','匯款',
    '地址','住址','幾樓','樓層',
    '手推車','推車','嬰兒車','汽座','安全座椅',
    '營業','開門','關門','打烊','幾點開','幾點關','今天有開','今日有開',
    '優惠','活動','折扣','促銷','特價'
  ];
  return kw.some(k => t.includes(k));
}

// 收件/送回/預約等動作意圖（小寫比對）
const ACTION_INTENT_RE = /(收件|收衣|到府|上門|來收|取件|預約|約收|送回|送件|送來|取回|還衣|送返|送還)/;

/* ---------------- 固定模板 ---------------- */
const TPL_BAG = [
  "包包清潔我們有專業流程 💼 會先確認材質與發霉或變色情況，再評估適合的處理方式。皮革類會盡量清潔並保養護理，若材質老化則會先告知風險。",
  "我們可以協助處理包包 👍 不同材質會採取不同方式，皮革會重視保養、布面則會加強清潔與定型。不過若有嚴重發霉或掉色，會先評估再進行。",
  "可以的喔，若包包有發霉或污漬多可改善 💼 但仍會依實際材質狀況而定，我們會先評估後再處理，盡量兼顧潔淨與外觀保護 ✨",
];
const TPL_SHOE = [
  "可以清潔鞋子,我們會依材質(布面/皮革/麂皮)調整方式,盡量恢復外觀 👟",
  "可以清潔鞋子子;如果有發霉、異味或黃斑多能改善,會先做不顯眼處測試再進行 😊",
  "可清潔;如果是皮革鞋會注意上油護理,布面鞋會加強清潔與定型 💙",
  "可以清洗;鞋底與縫線易藏污,我們會細清與除味,穿著感更好 ✨",
];
const TPL_CURTAIN = [
  "可以清潔窗簾,我們會依布料與織法調整流程,兼顧潔淨與版型 👌",
  "窗簾可處理;會先評估縮水與掉色風險,再安排合適方式 😊",
  "可清潔;若有特殊塗層會先做小範圍測試,處理後更清爽 💙",
  "窗簾可以清洗,會注意尺寸穩定與垂墜感,完成後更俐落 ✨",
];
const TPL_RUG = [
  "地毯可以清潔,我們會分區與深層清潔,兼顧纖維與色澤,整體觀感可望提升 ✨",
  "地毯可處理;會先做局部測試再進行深層清潔與除味,讓居家更清爽 😊",
  "可以清潔地毯;針對藏汙位置與邊緣收邊會特別留意,完成後更舒適 👍",
];
const TPL_QUILT = [
  "棉被可以清潔;我們會兼顧蓬鬆度與乾爽度,睡感可望更舒適 😊",
  "被子可處理;流程會保護纖維結構並充分烘透,使用上更衛生 💙",
  "可以清洗棉被;完成後會更乾淨清新,收納也更安心 ✨",
];

/* ---------------- 主處理 ---------------- */
class MessageHandler {
  constructor() {
    this.userState = {};
    this.lastReply = new Map();
    this.store = new Map();
    this.MAX_USES_PER_USER = Number(process.env.MAX_USES_PER_USER || 40);
    this.MAX_USES_TIME_PERIOD = Number(process.env.MAX_USES_TIME_PERIOD || 604800);
    this.recentOneTs = new Map();
    this.ONE_WINDOW_MS = 10 * 60 * 1000;
  }

  async checkUsage(userId) {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const ttl = this.MAX_USES_TIME_PERIOD * 1000;
    try {
      let arr = this.store.get(key) || [];
      arr = arr.filter(ts => ts > now - ttl);
      if (arr.length < this.MAX_USES_PER_USER) {
        arr.push(now);
        this.store.set(key, arr);
        return true;
      }
      return false;
    } catch (e) {
      logger.logError('Map 限流錯誤', e);
      return true;
    }
  }

  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片已接收,hash: ${imageHash}`);
      const result = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, { type: 'text', text: `${result}\n\n✨ 智能分析完成 👕` });
      logger.logImageAnalysis(userId, result);
    } catch (err) {
      logger.logError('污漬分析錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用,請稍後再試。' });
    }
  }

  /* ---- ✅ 管理員指令:發送付款連結 ---- */
  async handleAdminPaymentCommand(userId, text) {
    const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
    if (userId !== ADMIN_USER_ID) {
      return false;
    }

    // 格式: /付款 U客戶ID 王小明 1500 ecpay
    if (text.startsWith('/付款 ')) {
      const parts = text.split(' ');
      if (parts.length < 4) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '❌ 格式錯誤\n\n正確格式:\n/付款 [客戶ID] [姓名] [金額] [付款方式]\n\n範例:\n/付款 U1234567890 王小明 1500 ecpay\n/付款 U1234567890 王小明 2000 linepay'
        });
        return true;
      }

      const [_, customerId, customerName, amount, paymentType = 'ecpay'] = parts;
      try {
        let message = '';
        if (paymentType === 'ecpay') {
          const link = createECPayPaymentLink(customerId, customerName, parseInt(amount));
          let shortUrl = link;
          try {
            const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(link)}`);
            const result = await response.text();
            if (result && result.startsWith('http')) {
              shortUrl = result;
              logger.logToFile(`✅ 已縮短網址: ${shortUrl}`);
            }
          } catch (error) {
            logger.logToFile(`⚠️ 短網址生成失敗,使用原網址: ${error.message}`);
          }

          message = `您好,${customerName} 👋\n\n` +
                    `您的專屬付款連結已生成\n` +
                    `付款方式:信用卡\n` +
                    `金額:NT$ ${parseInt(amount).toLocaleString()}\n\n` +
                    `👉 請點擊下方連結完成付款\n${shortUrl}\n\n` +
                    `✅ 付款後系統會自動通知我們\n` +
                    `感謝您的支持 💙`;
        } else if (paymentType === 'linepay') {
          const LINE_PAY_URL = process.env.LINE_PAY_URL;
          message = `您好,${customerName} 👋\n\n` +
                    `您的專屬付款連結已生成\n` +
                    `付款方式:LINE Pay\n` +
                    `金額:NT$ ${parseInt(amount).toLocaleString()}\n\n` +
                    `👉 請點擊下方連結完成付款\n${LINE_PAY_URL}\n\n` +
                    `✅ 付款後系統會自動通知我們\n` +
                    `感謝您的支持 💙`;
        } else {
          await client.pushMessage(userId, { type: 'text', text: '❌ 不支援的付款方式\n請使用 ecpay 或 linepay' });
          return true;
        }

        await client.pushMessage(customerId, { type: 'text', text: message });
        await client.pushMessage(userId, {
          type: 'text',
          text: `✅ 已發送付款連結\n\n客戶:${customerName}\n金額:NT$ ${amount}\n方式:${paymentType === 'ecpay' ? '綠界' : 'LINE Pay'}`
        });

        logger.logToFile(`✅ [管理員指令] 已發送付款連結給 ${customerName} (${customerId}) - ${amount}元`);
      } catch (err) {
        logger.logError('發送付款連結失敗', err);
        await client.pushMessage(userId, { type: 'text', text: `❌ 發送失敗:${err.message}` });
      }
      return true;
    }
    return false;
  }

  /* ---- 文字訊息 ---- */
  async handleTextMessage(userId, text, originalMessage) {
    const raw = text || '';
    const lower = raw.toLowerCase().trim();
    let handledAddress = null; // 🩹 保險止血（如果其他地方還殘留此變數）

    // 管理員指令
    const isAdminCommand = await this.handleAdminPaymentCommand(userId, raw);
    if (isAdminCommand) return;

    // 按 1 的指令
    if (isOneKey(raw)) {
      this.recentOneTs.set(userId, Date.now());
      return this.handleNumberOneCommand(userId);
    }

    // 智能污漬分析
    if (/智能[污汙]漬分析/.test(raw)) {
      await client.pushMessage(userId, { type: 'text', text: '「想知道污漬的清潔成功率?」\n按 1 並上傳照片,我們提供貼心的智能分析,即時回應 🧼' });
      return;
    }

    // 🧭 地址偵測提示（像「文化路二段」但沒寫號）
    if (/路|街|巷|弄/.test(raw) && !/號/.test(raw)) {
      await client.pushMessage(userId, { 
        type: 'text', 
        text: '請提供完整地址（包含門牌號）才能查詢是否在免費收送範圍 🙏\n例如：「新北市板橋區文化路二段182巷1號」' 
      });
      return;
    }

    // 前置過濾
    if (ignoredKeywords.some(k => lower.includes(k.toLowerCase())) ||
        isEmojiOrPuncOnly(raw) || isSmallTalk(raw) || isPhoneNumberOnly(raw) ||
        isUrlOnly(raw) || isClearlyUnrelatedTopic(raw)) {
      logger.logToFile(`前置過濾忽略:「${raw}」(User ${userId})`);
      return;
    }

    // 檢查是否包含收件 / 送件 / 還衣等動作
    const isActionIntent = ACTION_INTENT_RE.test(raw);

    
   const rawClean = cleanText(raw);
let looksLikeAddress = false;
try {
  // 若 AddressDetector 沒有 isAddress 或拋錯，不讓整段炸掉；退回寬鬆判斷
  looksLikeAddress = (AddressDetector?.isAddress?.(rawClean) === true) || LOOSE_ADDR_RE.test(rawClean);
} catch (e) {
  logger.logToFile(`[AddressDetector] isAddress 檢查失敗：${e.message}`);
  looksLikeAddress = LOOSE_ADDR_RE.test(rawClean);
}

if (!isActionIntent && looksLikeAddress) {
  await this.handleAddressMessage(userId, raw);
  return;
}


    // 進度查詢
    if (this.isProgressQuery(lower)) {
      return this.handleProgressQuery(userId);
    }

    // 收件／收衣意圖
    if (/(收衣|收件|來收|到府|上門|取件)/.test(raw)) {
      const isSaturday = new Date().getDay() === 6;
      if (isSaturday) {
        const reply = "今天週六固定公休 🙏 明天週日有營業，我們可再安排收件時間。";
        await client.pushMessage(userId, { type: "text", text: reply });
        logger.logBotResponse(userId, originalMessage, reply, "Bot (Rule: pickup-sat-closed)");
        return;
      }

      let reply = "可以的 🙏 我們會到您輸入的地址收送，送達後再通知您 💙";

      try {
        const rawClean2 = cleanText(raw);
        let formatted = "";
        if (AddressDetector.isAddress(rawClean2)) {
          const r = AddressDetector.formatResponse(rawClean2) || {};
          formatted = r.formattedAddress || "";
        }
        if (!formatted) {
          const loose = rawClean2.match(LOOSE_ADDR_RE);
          if (loose) {
            const cityDistrict = autoDetectCityDistrict(rawClean2);
            formatted = `${cityDistrict}${loose[0].replace(/\s+/g, "")}`;
          }
        }
        if (formatted) {
          reply = `可以的 🙏 我們會到您輸入的地址收送：\n${formatted}\n送達後會再通知您 💙`;
        }
      } catch (err) {
        logger.logError("收件地址處理錯誤", err, userId);
      }

      await client.pushMessage(userId, { type: "text", text: reply });
      logger.logBotResponse(userId, originalMessage, reply, "Bot (Rule: pickup)");
      return;
    }

    // 汽座／手推車／嬰兒車
    const strollerKeywords = ['汽座','手推車','嬰兒推車','嬰兒車','安全座椅'];
    if (strollerKeywords.some(k => raw.includes(k))) {
      const reply = '這類寶寶用品我們都有處理 👶 會針對安全性與清潔特別注意。\n要詳細了解請按 2,謝謝您 😊';
      await client.pushMessage(userId, { type:'text', text: reply });
      logger.logBotResponse(userId, originalMessage, reply, 'Bot (Rule: stroller)');
      return;
    }

    // 包包
    if (/(包包|名牌包|手提袋|背包|書包)/.test(raw)) {
      const msg = pick(TPL_BAG);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: bag)');
      return;
    }
    
    // 鞋子
    if (/(有.*洗.*鞋|有洗鞋|鞋(子)?可以洗|洗鞋(服務)?)/i.test(raw) || /(鞋|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(raw)) {
      const msg = pick(TPL_SHOE);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: shoe)');
      return;
    }
    
    // 窗簾
    if (/(窗簾|布簾|遮光簾)/.test(raw)) {
      const msg = pick(TPL_CURTAIN);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: curtain)');
      return;
    }
    
    // 地毯
    if (/(地毯|地墊)/.test(raw)) {
      const msg = pick(TPL_RUG);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: rug)');
      return;
    }
    
    // 棉被
    if (/(棉被|被子|羽絨被)/.test(raw)) {
      const msg = pick(TPL_QUILT);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: quilt)');
      return;
    }

    // AI 回覆（洗衣相關）
    if (maybeLaundryRelated(raw)) {
      try {
        const aiText = await smartAutoReply(raw);
        if (aiText && aiText.trim()) {
          if (this.lastReply.get(userId) === aiText.trim()) return;
          await client.pushMessage(userId, { type: 'text', text: aiText });
          this.lastReply.set(userId, aiText.trim());
          logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
          return;
        }
      } catch (err) {
        logger.logError('AI 回覆錯誤', err, userId);
      }
    }

    logger.logToFile(`未回覆(非洗衣相關或 AI 判定無需回):${raw}`);
  }

  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks = []; 
      for await (const c of stream) chunks.push(c);
      const buffer = Buffer.concat(chunks);
      logger.logToFile(`收到圖片 (User ${userId}) len=${buffer.length}`);

      // 🔽 儲存圖片到永久 Volume
      const fs = require("fs");
      const path = require("path");
      const SAVE_DIR = "/data/uploads";
      if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
      const filePath = path.join(SAVE_DIR, `${messageId}.jpg`);
      fs.writeFileSync(filePath, buffer);
      console.log(`✅ 圖片已儲存到 ${filePath}`);


      const hasWaiting = this.userState[userId]?.waitingForImage === true;
      const lastOneTs = this.recentOneTs.get(userId) || 0;
      const withinWindow = Date.now() - lastOneTs <= this.ONE_WINDOW_MS;

      if (hasWaiting || withinWindow) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
        this.recentOneTs.delete(userId);
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用,請稍後再試。' });
    }
  }

  async handleNumberOneCommand(userId) {
    const ok = await this.checkUsage(userId);
    if (!ok) {
      await client.pushMessage(userId, { type: 'text', text: '您已達到每週使用上限,請下週再試喔～' });
      return;
    }
    this.userState[userId] = { waitingForImage: true };
    await client.pushMessage(userId, { type: 'text', text: '請上傳照片,以進行智能污漬分析 ✨📷' });
    logger.logToFile(`提示上傳照片 (User ${userId})`);
  }

  isProgressQuery(text) {
    const keys = ['洗好','洗好了嗎','可以拿了嗎','進度','好了嗎','完成了嗎','查進度','查詢進度'];
    return keys.some(k => text.includes(k));
  }

  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以線上查詢 C.H精緻洗衣 🔍\n或是營業時間會有專人回覆,謝謝您 🙏',
      quickReply: {
        items: [{
          type: 'action',
          action: { type: 'uri', label: '查詢進度', uri: 'https://liff.line.me/2004612704-JnzA1qN6' }
        }]
      }
    });
  }

  async handleAddressMessage(userId, address) {
    const original = address || '';
    const input = cleanText(original);

    // 1) 嚴格解析（可能成功，也可能抓不到）
    let formattedAddress = '';
    let response = '';
    try {
      const r = AddressDetector.formatResponse(input) || {};
      formattedAddress = r.formattedAddress || '';
      response = r.response || '';
    } catch (e) {
      logger.logError('地址解析失敗', e, userId);
    }

    // 2) 寬鬆補救：若嚴格解析失敗，但抓得到「路/街/號」，自動補市區
    if (!formattedAddress) {
      const loose = input.match(LOOSE_ADDR_RE);
      if (loose) {
        const cityDistrict = autoDetectCityDistrict(input);
        const guessed = `${cityDistrict}${loose[0].replace(/\s+/g,'')}`;
        formattedAddress = guessed;
        response = `已收到地址：${guessed}\n（若市/區需更改，請直接回覆正確完整地址 🙏）`;
      }
    }

    // 3) 還是抓不到 → 請用戶補充
    if (!formattedAddress) {
      await client.pushMessage(userId, {
        type:'text',
        text:'我沒有抓到完整地址 🙏\n請用這個格式提供：\n「新北市板橋區華江一路582號4樓」'
      });
      return;
    }

    // 4) 先回覆用戶（不受 Google 影響）
    const okText = response && response.trim()
      ? response
      : `已收到地址：${formattedAddress}\n我們會盡快安排收件，謝謝您 🙏`;
    await client.pushMessage(userId, { type:'text', text: okText });
    logger.logBotResponse(userId, original, okText, 'Bot (Address)');

    // 5) 背景寫入 Google（失敗只記錄，不打擾用戶）
    (async () => {
      try {
        const profile = await safeGetProfile(userId);
        await addCustomerInfo({
          userId,
          userName: profile.displayName || '',
          address: formattedAddress
        });
      } catch (err) {
        logger.logError('寫入Google失敗(不影響用戶)', err, userId);
      }
    })();
  }
}

module.exports = new MessageHandler();
