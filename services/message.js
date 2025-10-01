// services/message.js
const { Client } = require('@line/bot-sdk');
const { analyzeStainWithAI, smartAutoReply } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');

// LINE client
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 固定忽略（選單文字等）
const ignoredKeywords = [
  '常見問題', '服務價目&儲值優惠', '到府收送', '店面地址&營業時間',
  '付款方式', '寶寶汽座&手推車', '顧客須知', '智能污漬分析'
];

/* ---------------- 小工具 ---------------- */
const normalize = (s='') => (s || '').trim();
const isOneKey = (s='') => {
  const t = normalize(s);
  return t === '1' || t === '１';
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
// 判斷是否洗衣相關（用來決定要不要丟給 AI）
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

/* ---------------- 固定模板（更專業更自然） ---------------- */
// 包包
const TPL_BAG = [
  "您好，包包我們有專業處理 💼 會依材質調整方式，像皮革會注意保養護理，布面則加強清潔與定型，請您放心交給 C.H 精緻洗衣 😊",
  "包包是可以處理的 👍 我們會先檢視材質狀況，盡量在清潔同時保護原有外觀，有需要也能加強整形或護理 💙",
  "可以的喔 💼 包包清潔會依布料或皮革狀況分別處理，細節我們都會把關，請放心交給 C.H 精緻洗衣 ✨",
];
// 鞋子
const TPL_SHOE = [
  "可以清潔鞋子，我們會依材質（布面/皮革/麂皮）調整方式，盡量恢復外觀 👟",
  "鞋子可處理；發霉、異味或黃斑多能改善，會先做不顯眼處測試再進行 😊",
  "可清潔；皮革鞋會注意上油護理，布面鞋會加強清潔與定型 💙",
  "可以清洗；鞋底與縫線易藏污，我們會細清與除味，穿著感更好 ✨",
];
// 窗簾
const TPL_CURTAIN = [
  "可以清潔窗簾，我們會依布料與織法調整流程，兼顧潔淨與版型 👌",
  "窗簾可處理；會先評估縮水與掉色風險，再安排合適方式 😊",
  "可清潔；若有特殊塗層會先做小範圍測試，處理後更清爽 💙",
  "窗簾可以清洗，會注意尺寸穩定與垂墜感，完成後更俐落 ✨",
];
// 地毯
const TPL_RUG = [
  "地毯可以清潔，我們會分區與深層清潔，兼顧纖維與色澤，整體觀感可望提升 ✨",
  "地毯可處理；會先做局部測試再進行深層清潔與除味，讓居家更清爽 😊",
  "可以清潔地毯；針對藏汙位置與邊緣收邊會特別留意，完成後更舒適 👍",
];
// 棉被/被子
const TPL_QUILT = [
  "棉被可以清潔；我們會兼顧蓬鬆度與乾爽度，睡感可望更舒適 😊",
  "被子可處理；流程會保護纖維結構並充分烘透，使用上更衛生 💙",
  "可以清洗棉被；完成後會更乾淨清新，收納也更安心 ✨",
];

/* ---------------- 主處理 ---------------- */
class MessageHandler {
  constructor() {
    this.userState = {};
    this.lastReply = new Map();
    this.store = new Map();

    // 汙漬分析使用次數
    this.MAX_USES_PER_USER = Number(process.env.MAX_USES_PER_USER || 20);
    this.MAX_USES_TIME_PERIOD = Number(process.env.MAX_USES_TIME_PERIOD || 604800);

    // 按 1 視窗（避免重啟丟狀態）
    this.recentOneTs = new Map();
    this.ONE_WINDOW_MS = 10 * 60 * 1000;
  }

  /* ---- 限流（智能分析） ---- */
  async checkUsage(userId) {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const ttl = this.MAX_USES_TIME_PERIOD * 1000;
    try {
      let arr = this.store.get(key) || [];
      arr = arr.filter(ts => ts > now - ttl);
      if (arr.length < this.MAX_USES_PER_USER) {
        arr.push(now); this.store.set(key, arr); return true;
      }
      return false;
    } catch (e) {
      logger.logError('Map 限流錯誤', e);
      return true;
    }
  }

  /* ---- 汙漬分析 ---- */
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片已接收，hash: ${imageHash}`);
      const result = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, { type: 'text', text: `${result}\n\n✨ 智能分析完成 👕` });
      logger.logImageAnalysis(userId, result);
    } catch (err) {
      logger.logError('污漬分析錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  /* ---- 文字訊息 ---- */
  async handleTextMessage(userId, text, originalMessage) {
    const raw = text || '';
    const lower = raw.toLowerCase().trim();

    // 0) 「1」→ 立刻開啟智能分析（支援全形/半形）
    if (isOneKey(raw)) {
      this.recentOneTs.set(userId, Date.now());
      return this.handleNumberOneCommand(userId);
    }
    // 0.1) 直接輸入「智能污漬分析」→ 引導
    if (/智能[污汙]漬分析/.test(raw)) {
      await client.pushMessage(userId, {
        type: 'text',
        text: '「想知道污漬的清潔成功率？」\n按 1 並上傳照片，我們提供貼心的智能分析，即時回應 🧼'
      });
      return;
    }

    // 1) 忽略固定選單/無關訊息
    if (ignoredKeywords.some(k => lower.includes(k.toLowerCase())) ||
        isEmojiOrPuncOnly(raw) || isSmallTalk(raw) || isPhoneNumberOnly(raw) ||
        isUrlOnly(raw) || isClearlyUnrelatedTopic(raw)) {
      logger.logToFile(`前置過濾忽略：「${raw}」(User ${userId})`);
      return;
    }

    // 2) 地址偵測（含樓層）
    if (AddressDetector.isAddress(raw)) {
      await this.handleAddressMessage(userId, raw);
      return;
    }

    // 3) 進度查詢（固定回覆 + QuickReply）
    if (this.isProgressQuery(lower)) {
      return this.handleProgressQuery(userId);
    }

    // 4) 特規：汽座/手推車/嬰兒車 → 固定回覆 +「按 2」
    const strollerKeywords = ['汽座','手推車','嬰兒推車','嬰兒車','安全座椅'];
    if (strollerKeywords.some(k => raw.includes(k))) {
      const reply = '這類寶寶用品我們都有處理 👶 會針對安全性與清潔特別注意。\n要詳細了解請按 2，謝謝您 😊';
      await client.pushMessage(userId, { type:'text', text: reply });
      logger.logBotResponse(userId, originalMessage, reply, 'Bot (Rule: stroller)');
      return;
    }

    // 5) 品項模板（更自然的固定回覆）
    if (/(包包|名牌包|手提袋|背包|書包)/.test(raw)) {
      const msg = pick(TPL_BAG);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: bag)');
      return;
    }
    if (/(有.*洗.*鞋|有洗鞋|鞋(子)?可以洗|洗鞋(服務)?)/i.test(raw) || /(鞋|球鞋|運動鞋|皮鞋|靴子|涼鞋)/.test(raw)) {
      const msg = pick(TPL_SHOE);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: shoe)');
      return;
    }
    if (/(窗簾|布簾|遮光簾)/.test(raw)) {
      const msg = pick(TPL_CURTAIN);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: curtain)');
      return;
    }
    if (/(地毯|地墊)/.test(raw)) {
      const msg = pick(TPL_RUG);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: rug)');
      return;
    }
    if (/(棉被|被子|羽絨被)/.test(raw)) {
      const msg = pick(TPL_QUILT);
      await client.pushMessage(userId, { type: 'text', text: msg });
      logger.logBotResponse(userId, originalMessage, msg, 'Bot (Template: quilt)');
      return;
    }

    // 6) 其餘洗衣相關 → 交給 AI 高度判斷
    if (maybeLaundryRelated(raw)) {
      try {
        const aiText = await smartAutoReply(raw);
        if (aiText && aiText.trim()) {
          if (this.lastReply.get(userId) === aiText.trim()) return; // 避免重複
          await client.pushMessage(userId, { type: 'text', text: aiText });
          this.lastReply.set(userId, aiText.trim());
          logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
          return;
        }
      } catch (err) {
        logger.logError('AI 回覆錯誤', err, userId);
      }
    }

    // 7) 其它情況：不回（避免打擾）
    logger.logToFile(`未回覆（非洗衣相關或 AI 判定無需回）：${raw}`);
  }

  /* ---- 圖片訊息（雙保險） ---- */
  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks = []; for await (const c of stream) chunks.push(c);
      const buffer = Buffer.concat(chunks);
      logger.logToFile(`收到圖片 (User ${userId}) len=${buffer.length}`);

      const hasWaiting = this.userState[userId]?.waitingForImage === true;
      const lastOneTs = this.recentOneTs.get(userId) || 0;
      const withinWindow = Date.now() - lastOneTs <= this.ONE_WINDOW_MS;

      logger.logToFile(`waiting=${hasWaiting}, withinWindow=${withinWindow}`);

      if (hasWaiting || withinWindow) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
        this.recentOneTs.delete(userId);
      } else {
        // 想超保險可解開：任何圖片都嘗試分析
        // await this.handleStainAnalysis(userId, buffer);
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  /* ---- 「1」提示上傳 ---- */
  async handleNumberOneCommand(userId) {
    const ok = await this.checkUsage(userId);
    if (!ok) {
      await client.pushMessage(userId, { type: 'text', text: '您已達到每週使用上限，請下週再試喔～' });
      return;
    }
    this.userState[userId] = { waitingForImage: true };
    await client.pushMessage(userId, { type: 'text', text: '請上傳照片，以進行智能污漬分析 ✨📷' });
    logger.logToFile(`提示上傳照片 (User ${userId})`);
  }

  /* ---- 進度查詢 ---- */
  isProgressQuery(text) {
    const keys = ['洗好','洗好了嗎','可以拿了嗎','進度','好了嗎','完成了嗎','查進度','查詢進度'];
    return keys.some(k => text.includes(k));
  }
  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以線上查詢 C.H精緻洗衣 🔍\n或是營業時間會有專人回覆，謝謝您 🙏',
      quickReply: {
        items: [{
          type: 'action',
          action: { type: 'uri', label: '查詢進度', uri: 'https://liff.line.me/2004612704-JnzA1qN6' }
        }]
      }
    });
  }

  /* ---- 地址處理 ---- */
  async handleAddressMessage(userId, address) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } = AddressDetector.formatResponse(address);
      await addCustomerInfo({ userId, userName: profile.displayName, address: formattedAddress });
      await client.pushMessage(userId, { type: 'text', text: response });
      logger.logBotResponse(userId, address, response, 'Bot (Address)');
    } catch (err) {
      logger.logError('地址錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '抱歉，處理地址時發生錯誤，請稍後再試 🙏' });
    }
  }
}

module.exports = new MessageHandler();
