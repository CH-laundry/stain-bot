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

// 强制不回应列表
const ignoredKeywords = [
  "常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", 
  "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析", 
  "謝謝", "您好", "按錯"
];

class MessageHandler {
  constructor() {
    this.userState = {};
    this.store = new Map();
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 20;
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
  }

  /**
   * 处理智能污渍分析
   */
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片已接收，hash值: ${imageHash}`);

      const analysisResult = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, {
        type: 'text',
        text: `${analysisResult}\n\n✨ 智能分析完成 👕`
      });

      logger.logImageAnalysis(userId, analysisResult);
    } catch (err) {
      logger.logError('OpenAI 服務出現錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  /**
   * 处理文本消息
   */
  async handleTextMessage(userId, text, originalMessage) {
    const lowerText = text.toLowerCase();

    if (ignoredKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。(User ID: ${userId})`);
      return;
    }

    // 地址檢測
    if (AddressDetector.isAddress(text)) {
      await this.handleAddressMessage(userId, text);
      return;
    }

    // "1" → 啟動污漬分析
    if (text === '1') {
      return this.handleNumberOneCommand(userId);
    }

    // 查詢進度 → 固定回覆
    if (this.isProgressQuery(lowerText)) {
      return this.handleProgressQuery(userId);
    }

    // AI 回覆（已改成 smartAutoReply）
    const aiText = await smartAutoReply(text);
    if (aiText) {
      await client.pushMessage(userId, { type: 'text', text: aiText });
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    }
  }

  async handleImageMessage(userId, messageId) {
    try {
      logger.logToFile(`收到來自 ${userId} 的圖片訊息, 正在處理...(User ID: ${userId})`);
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      }
    } catch (err) {
      logger.logError('處理圖片時出錯', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  async handleNumberOneCommand(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '請上傳照片，以進行智能污漬分析✨📷'
    });
    this.userState[userId] = { waitingForImage: true };
  }

  isProgressQuery(text) {
    const progressKeywords = ["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"];
    return progressKeywords.some(k => text.includes(k));
  }

  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以這邊線上查詢 C.H精緻洗衣 🔍',
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
      logger.logError('處理地址訊息時出錯', error, userId);
      await client.pushMessage(userId, {
        type: 'text',
        text: '抱歉，處理您的地址時出現錯誤，請稍後再試。'
      });
    }
  }
}

module.exports = new MessageHandler();
