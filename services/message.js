// services/message.js
const { Client } = require('@line/bot-sdk');
const { analyzeStainWithAI, smartAutoReply } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');

// ===== 初始化 LINE 客戶端 =====
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// ===== 忽略：選單固定項目（避免重複回覆）=====
const ignoredKeywords = [
  '常見問題', '服務價目&儲值優惠', '到府收送', '店面地址&營業時間',
  '付款方式', '寶寶汽座&手推車', '顧客須知', '智能污漬分析'
];

class MessageHandler {
  constructor() {
    this.userState = {};
    this.store = new Map();
    this.MAX_USES_PER_USER = Number(process.env.MAX_USES_PER_USER || 20);            // 一週 20 次（你設定）
    this.MAX_USES_TIME_PERIOD = Number(process.env.MAX_USES_TIME_PERIOD || 604800);  // 7 天
  }

  // ------- 使用次數限制（供「1→污漬分析」使用）-------
  async checkUsage(userId) {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const ttl = this.MAX_USES_TIME_PERIOD * 1000;

    try {
      let actions = this.store.get(key) || [];
      actions = actions.filter(ts => ts > now - ttl);
      if (actions.length < this.MAX_USES_PER_USER) {
        actions.push(now);
        this.store.set(key, actions);
        return true;
      }
      return false;
    } catch (err) {
      logger.logError('Map 限流錯誤', err);
      return true; // 出錯時放行
    }
  }

  // ------- 圖片 → 污漬分析 -------
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
      logger.logToFile(`圖片收到，hash=${imageHash}`);

      const result = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, {
        type: 'text',
        text: `${result}\n\n✨ 智能分析完成 👕`
      });

      logger.logImageAnalysis(userId, result);
    } catch (err) {
      logger.logError('OpenAI 污漬分析錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  // ------- 文字訊息 -------
  async handleTextMessage(userId, text, originalMessage) {
    const lower = (text || '').toLowerCase().trim();

    // 1) 忽略固定選單的「標題文字」
    if (ignoredKeywords.some(k => lower.includes(k.toLowerCase()))) {
      logger.logToFile(`忽略固定選單項：「${text}」(User ${userId})`);
      return;
    }

    // 2) 地址偵測（含樓層）→ 直接寫入表單並回覆
    if (AddressDetector.isAddress(text)) {
      await this.handleAddressMessage(userId, text);
      return;
    }

    // 3) 「1」→ 啟動智能污漬分析
    if (text === '1') {
      return this.handleNumberOneCommand(userId);
    }

    // 4) 進度查詢（洗好了嗎 / 進度）
    if (this.isProgressQuery(lower)) {
      return this.handleProgressQuery(userId);
    }

    // 5) 交給 AI 高度判斷（寬鬆守門＋分類＋保底回覆都在 openai.js）
    try {
      const aiText = await smartAutoReply(text);
      if (aiText && aiText.trim()) {
        await client.pushMessage(userId, { type: 'text', text: aiText });
        logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
      } else {
        logger.logToFile(`smartAutoReply 無回覆（可能非洗衣主題或被守門）：${text}`);
      }
    } catch (err) {
      logger.logError('AI 自動回覆錯誤', err, userId);
    }
  }

  // ------- 圖片訊息 -------
  async handleImageMessage(userId, messageId) {
    try {
      logger.logToFile(`收到圖片，準備下載處理 (User ${userId})`);
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      } else {
        logger.logToFile(`非分析模式下收到圖片，略過 (User ${userId})`);
      }
    } catch (err) {
      logger.logError('處理圖片錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '圖片處理失敗，請再試一次～' });
    }
  }

  // ------- 「1」→ 提示上傳照片 -------
  async handleNumberOneCommand(userId) {
    const ok = await this.checkUsage(userId);
    if (!ok) {
      await client.pushMessage(userId, { type: 'text', text: '您已達到每週使用上限，請下週再試喔～' });
      return;
    }
    this.userState[userId] = { waitingForImage: true };
    await client.pushMessage(userId, {
      type: 'text',
      text: '請上傳照片，以進行智能污漬分析 ✨📷'
    });
    logger.logToFile(`提示上傳照片 (User ${userId})`);
  }

  // ------- 是否為進度查詢 -------
  isProgressQuery(text) {
    const keys = ['洗好', '洗好了嗎', '可以拿了嗎', '進度', '好了嗎', '完成了嗎', '查進度', '查詢進度'];
    return keys.some(k => text.includes(k));
  }

  // ------- 回覆查詢連結（+ 你要的那句話）-------
  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '您可以這邊線上查詢 C.H精緻洗衣 🔍\n或是營業時間會有專人回覆，謝謝您 🙏',
      quickReply: {
        items: [{
          type: 'action',
          action: {
            type: 'uri',
            label: '查詢進度',
            uri: 'https://liff.line.me/2004612704-JnzA1qN6'
          }
        }]
      }
    });
  }

  // ------- 地址處理（寫入 Google Sheet，回覆給客人）-------
  async handleAddressMessage(userId, address) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } = AddressDetector.formatResponse(address);

      const info = {
        userId,
        userName: profile.displayName,
        address: formattedAddress
      };
      await addCustomerInfo(info);

      await client.pushMessage(userId, { type: 'text', text: response });
      logger.logBotResponse(userId, address, response, 'Bot (Address)');
    } catch (err) {
      logger.logError('處理地址錯誤', err, userId);
      await client.pushMessage(userId, {
        type: 'text',
        text: '抱歉，處理您的地址時出現問題，請稍後再試 🙏'
      });
    }
  }
}

module.exports = new MessageHandler();
