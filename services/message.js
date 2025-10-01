const { Client } = require('@line/bot-sdk');
const { detectInquiryType } = require('../inquiryType');
const { analyzeStainWithAI, smartAutoReply } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');

// 初始化 LINE 客户端
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 固定忽略的關鍵字
const ignoredKeywords = [
  "常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間",
  "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析",
  "謝謝", "您好", "按錯"
];

// ============== 前置過濾工具 ==============
function normalize(s=""){ return (s||"").trim(); }
function isEmojiOrPuncOnly(s=""){
  const t=(s||"").trim();
  if(!t) return true;
  const stripped = t.replace(/[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}\s、，。．。！？!?.…~\-—_()*^%$#@＋+／/\\|:;"'<>【】\[\]{}]/gu,"");
  return stripped.length===0;
}
function isSmallTalk(t=""){
  const s=normalize(t).toLowerCase();
  const patterns=[/^謝謝/,/^感謝/,/^辛苦了$/, /^抱歉$/, /^不好意思$/, /^沒關係$/, /^不會$/, /^好的?$/, /^ok$/, /^了解$/, /^知道$/, /^嗯+$/, /^哈+$/, /^呵+$/, /^不是$/];
  return patterns.some(re=>re.test(s));
}
function isPhoneNumberOnly(t=""){ return /^09\d{8}$/.test(t.replace(/\s/g,"")); }
function isUrlOnly(t=""){ return /^(https?:\/\/|www\.)\S+$/.test(t); }

// ============== 主處理類 ==============
class MessageHandler {
  constructor() {
    this.userState = {};
    this.lastReply = new Map(); // 避免重複回覆
    this.store = new Map();
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
  }

  // ========== 污漬分析 ==========
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片已接收，hash: ${imageHash}`);

      const analysisResult = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, { type: 'text', text: `${analysisResult}\n\n✨ 智能分析完成 👕` });
      logger.logImageAnalysis(userId, analysisResult);
    } catch (err) {
      logger.logError('污漬分析錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  // ========== 文字訊息 ==========
  async handleTextMessage(userId, text, originalMessage) {
    const lower = (text || '').toLowerCase().trim();

    // 前置過濾
    if (ignoredKeywords.some(k=>lower.includes(k.toLowerCase())) ||
        isEmojiOrPuncOnly(text) || isSmallTalk(text) || isPhoneNumberOnly(text) || isUrlOnly(text)) {
      logger.logToFile(`忽略訊息: ${text} (User ${userId})`);
      return;
    }

    // 地址
    if (AddressDetector.isAddress(text)) return this.handleAddressMessage(userId, text);

    // 「1」→ 污漬分析
    if (text === '1') return this.handleNumberOneCommand(userId);

    // 進度查詢
    if (this.isProgressQuery(lower)) return this.handleProgressQuery(userId);

    // 特殊品項：手推車 / 汽座
    if (/手推車|推車|汽座|安全座椅/.test(text)) {
      const msg = "這類嬰幼兒用品我們也可以清洗，請您放心交給 C.H精緻洗衣 🙌\n若需要更詳細資訊，請按 2 查看 💡";
      await client.pushMessage(userId, { type: 'text', text: msg });
      return;
    }

    // AI 高判斷
    try {
      const aiText = await smartAutoReply(text);
      if (!aiText) return;

      // 避免重複
      const last = this.lastReply.get(userId);
      if (last && last === aiText.trim()) return;

      await client.pushMessage(userId, { type: 'text', text: aiText });
      this.lastReply.set(userId, aiText.trim());
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    } catch (err) {
      logger.logError('AI 回覆錯誤', err, userId);
    }
  }

  // ========== 圖片 ==========
  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks=[]; for await (const c of stream) chunks.push(c);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  // ========== 污漬分析入口 ==========
  async handleNumberOneCommand(userId) {
    await client.pushMessage(userId, { type: 'text', text: '請上傳照片，以進行智能污漬分析 ✨📷' });
    this.userState[userId] = { waitingForImage: true };
  }

  // ========== 進度查詢 ==========
  isProgressQuery(text) {
    const keys=["洗好","洗好了嗎","可以拿了嗎","進度","好了嗎","完成了嗎"];
    return keys.some(k=>text.includes(k));
  }
  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以線上查詢 C.H精緻洗衣 🔍\n或是營業時間專人回覆，謝謝您 😊',
      quickReply: { items: [{ type:"action", action:{ type:"uri", label:"查詢進度", uri:"https://liff.line.me/2004612704-JnzA1qN6" }}]}
    });
  }

  // ========== 地址處理 ==========
  async handleAddressMessage(userId, address) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } = AddressDetector.formatResponse(address);
      await addCustomerInfo({ userId, userName: profile.displayName, address: formattedAddress });
      await client.pushMessage(userId, { type:'text', text: response });
    } catch (err) {
      logger.logError('地址錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '抱歉，處理地址時發生錯誤，請稍後再試。' });
    }
  }
}

module.exports = new MessageHandler();
