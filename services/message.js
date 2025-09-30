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
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 20;
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
  }

  /**
   * 智能污漬分析
   */
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      console.log(`[DEBUG] 進入 handleStainAnalysis for ${userId}`);
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片已接收，hash值: ${imageHash}`);

      const analysisResult = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, {
        type: 'text',
        text: `${analysisResult}\n\n✨ 智能分析完成 👕`
      });

      logger.logImageAnalysis(userId, analysisResult);
    } catch (err) {
      console.error('[DEBUG] handleStainAnalysis 錯誤:', err);
      logger.logError('OpenAI 服務出現錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  /**
   * 文字訊息處理
   */
  async handleTextMessage(userId, text, originalMessage) {
    console.log(`[DEBUG] 收到用戶(${userId})訊息:`, text);

    const lowerText = text.toLowerCase();

    if (ignoredKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      console.log(`[DEBUG] 訊息被忽略: ${text}`);
      return;
    }

    // 地址檢測
    if (AddressDetector.isAddress(text)) {
      console.log(`[DEBUG] 偵測到地址: ${text}`);
      await this.handleAddressMessage(userId, text);
      return;
    }

    // "1" → 啟動污漬分析
    if (text === '1') {
      console.log(`[DEBUG] 偵測到輸入 1，準備啟動污漬分析`);
      return this.handleNumberOneCommand(userId);
    }

    // 查詢進度
    if (this.isProgressQuery(lowerText)) {
      console.log(`[DEBUG] 偵測到進度查詢`);
      return this.handleProgressQuery(userId);
    }

    // AI 自動回覆
    console.log(`[DEBUG] 進入 smartAutoReply() for ${text}`);
    const aiText = await smartAutoReply(text);
    if (aiText) {
      console.log(`[DEBUG] AI 回覆內容: ${aiText}`);
      await client.pushMessage(userId, { type: 'text', text: aiText });
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    } else {
      console.log(`[DEBUG] smartAutoReply 無回覆 for ${text}`);
    }
  }

  /**
   * 圖片訊息處理
   */
  async handleImageMessage(userId, messageId) {
    try {
      console.log(`[DEBUG] 收到 ${userId} 的圖片，ID: ${messageId}`);
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        console.log(`[DEBUG] 偵測到用戶等待上傳圖片，開始分析...`);
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      } else {
        console.log(`[DEBUG] 用戶沒有等待圖片，忽略圖片訊息`);
      }
    } catch (err) {
      console.error('[DEBUG] handleImageMessage 錯誤:', err);
      logger.logError('處理圖片時出錯', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  /**
   * 處理按 1 指令
   */
  async handleNumberOneCommand(userId) {
    console.log(`[DEBUG] handleNumberOneCommand 執行 for ${userId}`);
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
    console.log(`[DEBUG] handleProgressQuery 執行 for ${userId}`);
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
      console.log(`[DEBUG] handleAddressMessage 執行 for ${userId}, 地址: ${address}`);
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
      console.error('[DEBUG] handleAddressMessage 錯誤:', error);
      logger.logError('處理地址訊息時出錯', error, userId);
      await client.pushMessage(userId, {
        type: 'text',
        text: '抱歉，處理您的地址時出現錯誤，請稍後再試。'
      });
    }
  }
}

module.exports = new MessageHandler();
