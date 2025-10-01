// services/message.js
const { Client } = require('@line/bot-sdk');
const { analyzeStainWithAI, smartAutoReply } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');

// 初始化 LINE 客戶端
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 固定忽略：選單標題（※ 智能污漬分析 會在前面優先判斷，不會真的被忽略）
const ignoredKeywords = [
  '常見問題', '服務價目&儲值優惠', '到府收送', '店面地址&營業時間',
  '付款方式', '寶寶汽座&手推車', '顧客須知', '智能污漬分析'
];

// ============== 前置過濾工具 ==============
function normalize(s = '') { return (s || '').trim(); }

function isEmojiOrPuncOnly(s = '') {
  const t = (s || '').trim();
  if (!t) return true;
  const stripped = t.replace(
    /[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}\s、，。．。！？!?.…~\-—_()*^%$#@＋+／/\\|:;"'<>【】\[\]{}]/gu,
    ''
  );
  return stripped.length === 0;
}

// 日常寒暄/無關單字/無意義短訊
function isSmallTalk(t = '') {
  const s = normalize(t).toLowerCase();
  const patterns = [
    /^謝謝(你|您)?$/, /^感謝(你|您)?$/, /^辛苦了$/, /^抱歉$/, /^不好意思$/,
    /^沒關係$/, /^不會$/, /^好的?$/, /^ok$|^okay$/i, /^收到$/, /^了解$/, /^知道了?$/,
    /^嗯+$|^喔+$|^哦+$|^啊+$|^欸+$/i, /^哈哈+$/i, /^呵呵+$/i, /^哈囉$|^hello$|^hi$|^嗨$/i,
    /^在嗎\??$/, /^在\??$/, /^有人在嗎\??$/, /^有人嗎\??$/, /^不是$/,
    /^早安$|^午安$|^晚安$/,
    /^測試$/, /^test$/i
  ];
  return patterns.some(re => re.test(s));
}

// 純電話 / 純網址
function isPhoneNumberOnly(t = '') {
  const s = t.replace(/\s|-/g, '');
  return /^09\d{8}$/.test(s) || /^0\d{1,3}\d{6,8}$/.test(s) || /^\+886\d{9}$/.test(s);
}
function isUrlOnly(t = '') { return /^(https?:\/\/|www\.)\S+$/i.test(t.trim()); }

// 明顯與洗衣無關的主題（天氣、聊天）
function isClearlyUnrelatedTopic(t = '') {
  const s = t.toLowerCase();
  const weather = /(天氣|下雨|出太陽|晴天|颱風|好熱|很熱|好冷|很冷|溫度|涼|熱)/;
  const chitchat = /(在幹嘛|在忙嗎|聊聊|聊天|怎麼樣|最近如何|在不在)/;
  return weather.test(s) || chitchat.test(s);
}

// 支援全形/半形 1
function isOneKey(t = '') {
  const s = normalize(t);
  return s === '1' || s === '１';
}

// ============== 主處理類 ==============
class MessageHandler {
  constructor() {
    this.userState = {};
    this.lastReply = new Map();                // 避免重複回覆
    this.store = new Map();
    this.recentOneTs = new Map();              // ★ 新增：記錄「按 1」時間戳（毫秒）
    this.ONE_WINDOW_MS = 5 * 60 * 1000;        // ★ 新增：5 分鐘內收到圖片皆可分析

    this.MAX_USES_PER_USER = Number(process.env.MAX_USES_PER_USER || 20);
    this.MAX_USES_TIME_PERIOD = Number(process.env.MAX_USES_TIME_PERIOD || 604800);
  }

  // 使用次數限制（供「1→污漬分析」用）
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
    } catch (e) { logger.logError('Map 限流錯誤', e); return true; }
  }

  // 污漬分析
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

  // 文字訊息
  async handleTextMessage(userId, text, originalMessage) {
    const raw = text || '';
    const lower = raw.toLowerCase().trim();

    // ★ 0) 若使用者直接打「智能污漬分析」→ 主動引導按 1 上傳
    if (/智能[污汙]漬分析/.test(raw)) {
      await client.pushMessage(userId, { type: 'text', text: '「想知道污漬的清潔成功率？」\n按 1 並上傳照片，我們提供貼心的智能分析，即時回應 🧼' });
      return;
    }

    // 1) 選單標題 → 忽略
    if (ignoredKeywords.some(k => lower.includes(k.toLowerCase()))) {
      logger.logToFile(`忽略固定選單項：「${raw}」(User ${userId})`);
      return;
    }

    // 2) 前置過濾：emoji/標點、寒暄、純電話、純網址、與洗衣無關主題 → 不回
    if (isEmojiOrPuncOnly(raw) || isSmallTalk(raw) || isPhoneNumberOnly(raw) || isUrlOnly(raw) || isClearlyUnrelatedTopic(raw)) {
      logger.logToFile(`前置過濾忽略：「${raw}」(User ${userId})`);
      return;
    }

    // 3) 地址偵測（含樓層）
    if (AddressDetector.isAddress(raw)) {
      await this.handleAddressMessage(userId, raw);
      return;
    }

    // 4) 「1」→ 污漬分析（支援全形），同時記錄時間戳
    if (isOneKey(raw)) {
      this.recentOneTs.set(userId, Date.now());     // ★ 記錄 "1" 的時間
      logger.logToFile(`收到「1」，標記 waiting 與時間戳 (User ${userId})`);
      return this.handleNumberOneCommand(userId);
    }

    // 5) 進度查詢
    if (this.isProgressQuery(lower)) {
      return this.handleProgressQuery(userId);
    }

    // 6) 交給 AI 高判斷（openai.js 嚴格門檻：非洗衣相關直接不回）
    try {
      const aiText = await smartAutoReply(raw);
      if (!aiText || !aiText.trim()) {
        logger.logToFile(`AI 判斷非洗衣主題或無需回覆：「${raw}」(User ${userId})`);
        return;
      }

      // 避免連續回同一句
      const last = this.lastReply.get(userId);
      if (last && last === aiText.trim()) {
        logger.logToFile(`避免重複回覆，略過 (User ${userId})`);
        return;
      }

      await client.pushMessage(userId, { type: 'text', text: aiText });
      this.lastReply.set(userId, aiText.trim());
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    } catch (err) {
      logger.logError('AI 回覆錯誤', err, userId);
    }
  }

  // 圖片訊息
  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks = []; for await (const c of stream) chunks.push(c);
      const buffer = Buffer.concat(chunks);
      logger.logToFile(`收到圖片事件 (User ${userId})，buffer length=${buffer.length}`);

      // ★ 雙保險條件：
      //  A) 仍有 waitingForImage
      //  B) 或者 5 分鐘內剛按過「1」
      const hasWaiting = this.userState[userId]?.waitingForImage === true;
      const lastOneTs = this.recentOneTs.get(userId) || 0;
      const withinWindow = Date.now() - lastOneTs <= this.ONE_WINDOW_MS;

      logger.logToFile(`waiting=${hasWaiting}, withinWindow=${withinWindow}`);

      if (hasWaiting || withinWindow) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
        // 清掉 timestamp，避免之後任意圖片都觸發
        this.recentOneTs.delete(userId);
      } else {
        // 沒有 waiting 且不在 5 分鐘內：不分析，以免誤觸
        logger.logToFile(`未觸發分析（沒有 waiting，且不在 5 分鐘內）(User ${userId})`);
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  // 「1」→ 提示上傳照片
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

  // 進度查詢
  isProgressQuery(text) {
    const keys = ['洗好', '洗好了嗎', '可以拿了嗎', '進度', '好了嗎', '完成了嗎', '查進度', '查詢進度'];
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

  // 地址處理
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
