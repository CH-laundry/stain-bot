const { Client } = require('@line/bot-sdk');
const { detectInquiryType } = require('../inquiryType');
const { analyzeStainWithAI, getAIResponse } = require('./openai');
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

// 小工具：支援全形/半形 1
function isOneKey(s = '') {
  const t = (s || '').trim();
  return t === '1' || t === '１';
}

class MessageHandler {
  constructor() {
    this.userState = {};
    this.store = new Map();
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;

    // ★ 新增：記錄按「1」的時間戳，10 分鐘內上傳圖片也會觸發分析（避免重啟丟狀態）
    this.recentOneTs = new Map();
    this.ONE_WINDOW_MS = 10 * 60 * 1000;
  }

  /**
   * 判断是否与洗衣店相关
   */
  isLaundryRelatedText(text) {
    const lowerText = (text || '').toLowerCase();
    const keywords = [
      { lang: "zh-TW", keywords: ["洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾", "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", "書包", "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約"] },
      { lang: "zh-CN", keywords: ["洗衣", "清洗", "污渍", "油渍", "血渍", "酱油", "染色", "退色", "地毯", "窗帘", "宝宝汽座", "汽座", "儿童座椅", "安全儿童座椅", "手推车", "单人手推车", "宝宝手推车", "书包", "营业", "开门", "休息", "开店", "有开", "收送", "到府", "上门", "收衣", "预约"] },
      { lang: "en", keywords: ["laundry", "clean", "stain", "oil stain", "blood stain", "soy sauce", "dyeing", "fading", "carpet", "curtain", "baby car seat", "car seat", "child seat", "stroller", "baby stroller", "backpack", "open", "business hours", "pickup", "delivery", "collect clothes", "reservation"] },
      { lang: "ja", keywords: ["洗濯", "クリーニング", "汚れ", "油汚れ", "血", "醤油", "染色", "色落ち", "カーペット", "カーテン", "ベビーシート", "チャイルドシート", "ベビーカー", "ランドセル", "営業", "開店", "休憩", "オープン", "集荷", "配達", "予約"] }
    ];
    return keywords.some(inquiry => inquiry.keywords.some(keyword => lowerText.includes(keyword.toLowerCase())));
  }

  /**
   * 检查使用次数限制
   */
  async checkUsage(userId) {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const timePeriodMs = this.MAX_USES_TIME_PERIOD * 1000;

    try {
      let userActions = this.store.get(key) || [];
      userActions = userActions.filter(timestamp => timestamp > now - timePeriodMs);

      if (userActions.length < this.MAX_USES_PER_USER) {
        userActions.push(now);
        this.store.set(key, userActions);
        return true;
      }
      return false;
    } catch (error) {
      logger.logError("Map 存储限流错误", error);
      return true;
    }
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
      await client.pushMessage(userId, {
        type: 'text',
        text: '服務暫時不可用，請稍後再試。'
      });
    }
  }

  /**
   * 处理文本消息
   */
  async handleTextMessage(userId, text, originalMessage) {
    const lowerText = (text || '').toLowerCase();

    // ✅ 先處理「1」鍵（含全形）：避免被其它規則蓋掉
    if (isOneKey(text)) {
      this.recentOneTs.set(userId, Date.now()); // 記錄這次按 1 的時間
      return this.handleNumberOneCommand(userId);
    }

    // ✅ 使用者直接打「智能污漬分析」→ 主動引導
    if (/智能[污汙]漬分析/.test(text || '')) {
      await client.pushMessage(userId, {
        type: 'text',
        text: '「想知道污漬的清潔成功率？」\n按 1 並上傳照片，我們提供貼心的智能分析，即時回應 🧼'
      });
      return;
    }

    // 檢查是否包含强制不回应的关键字
    if (ignoredKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。(User ID: ${userId})`);
      return;
    }

    // 检测是否是地址
    if (AddressDetector.isAddress(text)) {
      await this.handleAddressMessage(userId, text);
      return;
    }

    // 处理进度查询
    if (this.isProgressQuery(lowerText)) {
      return this.handleProgressQuery(userId);
    }

    // 检测询问类型（你的自訂規則）
    const inquiryResult = detectInquiryType(text);
    if (inquiryResult) {
      await client.pushMessage(userId, {
        type: 'text',
        text: inquiryResult
      });
      logger.logBotResponse(userId, originalMessage, inquiryResult);
      return;
    }

    // AI 客服回应
    if (this.isLaundryRelatedText(text)) {
      await this.handleAIResponse(userId, text, originalMessage);
    } else {
      logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，不使用AI回應。(User ID: ${userId})`);
    }
  }

  /**
   * 处理图片消息 —— ★ 強化：雙保險
   */
  async handleImageMessage(userId, messageId) {
    try {
      logger.logToFile(`收到來自 ${userId} 的圖片訊息, 正在處理...(User ID: ${userId})`);

      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // A) 原本就有的 waiting 狀態
      const hasWaiting = this.userState[userId]?.waitingForImage;

      // B) 10 分鐘內剛按過 1
      const lastOne = this.recentOneTs.get(userId) || 0;
      const withinWindow = (Date.now() - lastOne) <= this.ONE_WINDOW_MS;

      logger.logToFile(`waiting=${!!hasWaiting}, withinWindow=${withinWindow} (User ${userId})`);

      if (hasWaiting || withinWindow) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
        this.recentOneTs.delete(userId);
      } else {
        // 若你想更保險，也可直接嘗試分析（避免 state 遺漏）：
        // await this.handleStainAnalysis(userId, buffer);
        // 目前保守起見：沒按 1 就不自動分析
      }
    } catch (err) {
      logger.logError('處理圖片時出錯', err, userId);
      await client.pushMessage(userId, {
        type: 'text',
        text: '服務暫時不可用，請稍後再試。'
      });
    }
  }

  /**
   * 处理"1"命令
   */
  async handleNumberOneCommand(userId) {
    const usage = await this.checkUsage(userId);
    if (!usage) {
      await client.pushMessage(userId, {
        type: 'text',
        text: '您已達到每週2次的使用上限，請下週再試。'
      });
      return;
    }

    await client.pushMessage(userId, {
      type: 'text',
      text: '請上傳照片，以進行智能污漬分析✨📷'
    });

    this.userState[userId] = { waitingForImage: true };
    logger.logToFile(`Bot 回覆用戶 ${userId}: 請上傳照片，以進行智能污漬分析✨📷(User ID: ${userId})`);
  }

  /**
   * 判断是否为进度查询
   */
  isProgressQuery(text) {
    const progressKeywords = ["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"];
    return progressKeywords.some(k => text.includes(k));
  }

  /**
   * 处理进度查询
   */
  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: 'text',
      text: '營業時間會馬上查詢您的清洗進度😊，並回覆您！或是您可以這邊線上查詢 C.H精緻洗衣 謝謝您🔍',
      quickReply: {
        items: [{
          type: "action",
          action: {
            type: "uri",
            label: "C.H精緻洗衣",
            uri: "https://liff.line.me/2004612704-JnzA1qN6"
          }
        }]
      }
    });
  }

  /**
   * 处理AI回应
   */
  async handleAIResponse(userId, text, originalMessage) {
    try {
      const aiText = await getAIResponse(text);
      if (!aiText || aiText.includes('無法回答')) {
        logger.logToFile(`無法回答的問題: ${text}(User ID: ${userId})`);
        return;
      }

      await client.pushMessage(userId, {
        type: 'text',
        text: aiText
      });
      logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
    } catch (error) {
      logger.logError('AI 服務出現錯誤', error, userId);
    }
  }

  /**
   * 处理地址消息
   */
  async handleAddressMessage(userId, address) {
    try {
      // 获取用户资料
      const profile = await client.getProfile(userId);

      // 格式化地址并获取回复
      const { formattedAddress, response } = AddressDetector.formatResponse(address);

      // 准备客户信息
      const customerInfo = {
        userId: userId,
        userName: profile.displayName,
        address: formattedAddress
      };

      // 添加到 Google Sheets
      await addCustomerInfo(customerInfo);

      // 发送回复消息
      await client.pushMessage(userId, {
        type: 'text',
        text: response
      });

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
