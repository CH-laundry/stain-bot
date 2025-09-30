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

// 強制不回應列表
const ignoredKeywords = [
  "常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間",
  "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析",
  "謝謝", "您好", "按錯"
];

class MessageHandler {
  constructor() {
    this.userState = {};
    this.store = new Map();
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 20; // 預設一週 20 次
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800; // 預設 7 天
  }

  /**
   * 污漬智能分析
   */
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`收到圖片，hash=${imageHash}`);

      const result = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, {
        type: 'text',
        text: `${result}\n\n✨ 智能分析完成 👕`
      });

      logger.logImageAnalysis(userId, result);
    } catch (err) {
      logger.logError('污漬分析錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '分析暫時不可用，請稍後再試 🙏' });
    }
  }

  /**
   * 處理文字訊息
   */
  async handleTextMessage(userId, text, originalMessage) {
    const lowerText = text.toLowerCase();

    // 忽略特定訊息
    if (ignoredKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      logger.logToFile(`訊息忽略: ${text} (User ID: ${userId})`);
      return;
    }

    // 地址偵測
    if (AddressDetector.isAddress(text)) {
      return this.handleAddressMessage(userId, text);
    }

    // 按 "1" → 啟動智能污漬分析
    if (text === '1') {
      return this.handleNumberOneCommand(userId);
    }

    // 查詢進度
    if (this.isProgressQuery(lowerText)) {
      return this.handleProgressQuery(userId);
    }

    // AI 高度判斷回覆
    const aiText = await smartAutoReply(text);
    if (aiText) {
      await client.pushMessage(userId, { type: 'text', text: aiText });
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    }
  }

  /**
   * 處理圖片訊息
   */
  async handleImageMessage(userId, messageId) {
    try {
      logger.logToFile(`收到 ${userId} 的圖片，準備處理...`);
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '處理圖片時出現錯誤，請稍後再試 🙏' });
    }
  }

  /**
   * 按 "1" 的行為
   */
  async handleNumberOneCommand(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '請上傳照片，以進行智能污漬分析 ✨📷'
    });
    this.userState[userId] = { waitingForImage: true };
  }

  /**
   * 判斷是否為進度查詢
   */
  isProgressQuery(text) {
    const keys = ["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"];
    return keys.some(k => text.includes(k));
  }

  /**
   * 回覆進度查詢
   */
  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以隨時線上查詢 C.H 精緻洗衣 🔍',
      quickReply: {
        items: [{
          type: "action",
          action: {
            type: "uri",
            label: "查詢進度",
            uri: "https://liff.line.me/2004612704-JnzA1qN6"
          }
        }]
      }
    });
  }

  /**
   * 地址訊息處理
   */
  async handleAddressMessage(userId, address) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } = AddressDetector.formatResponse(address);

      const customerInfo = {
        userId,
        userName: profile.displayName,
        address: formattedAddress
      };
      await addCustomerInfo(customerInfo);

      await client.pushMessage(userId, { type: 'text', text: response });
      logger.logBotResponse(userId, address, response, 'Bot (Address)');
    } catch (error) {
      logger.logError('處理地址訊息錯誤', error, userId);
      await client.pushMessage(userId, {
        type: 'text',
        text: '抱歉，處理地址時出現錯誤，請稍後再試 🙏'
      });
    }
  }
}

module.exports = new MessageHandler();
