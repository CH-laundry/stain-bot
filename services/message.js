const { Client } = require("@line/bot-sdk");
const { analyzeStainWithAI, smartAutoReply } = require("./openai");
const logger = require("./logger");
const { createHash } = require("crypto");
const AddressDetector = require("../utils/address");
const { addCustomerInfo } = require("./google");

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 不回應清單
const ignoredKeywords = ["常見問題", "謝謝", "您好", "按錯"];

class MessageHandler {
  constructor() {
    this.userState = {};
    this.store = new Map();
    this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 20;
    this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
  }

  // --- 污漬分析 ---
  async handleStainAnalysis(userId, imageBuffer) {
    try {
      const imageHash = createHash("sha256").update(imageBuffer).digest("hex");
      logger.logToFile(`收到圖片 hash: ${imageHash}`);

      const result = await analyzeStainWithAI(imageBuffer);
      await client.pushMessage(userId, {
        type: "text",
        text: `${result}\n\n✨ 智能分析完成 👕`,
      });
    } catch (err) {
      logger.logError("污漬分析錯誤", err, userId);
      await client.pushMessage(userId, { type: "text", text: "服務暫時不可用，請稍後再試 🙏" });
    }
  }

  // --- 文字訊息 ---
  async handleTextMessage(userId, text, originalMessage) {
    const lower = text.toLowerCase();
    if (ignoredKeywords.some((kw) => lower.includes(kw.toLowerCase()))) return;

    // 地址
    if (AddressDetector.isAddress(text)) {
      return this.handleAddressMessage(userId, text);
    }

    // 「1」→ 啟動智能污漬分析
    if (text === "1") {
      this.userState[userId] = { waitingForImage: true };
      await client.pushMessage(userId, { type: "text", text: "請上傳照片，以進行智能污漬分析 ✨📷" });
      return;
    }

    // 查詢進度
    if (this.isProgressQuery(lower)) {
      return this.handleProgressQuery(userId);
    }

    // AI 自動回應
    const reply = await smartAutoReply(text);
    if (reply) {
      await client.pushMessage(userId, { type: "text", text: reply });
      logger.logBotResponse(userId, originalMessage, reply, "Bot (AI)");
    }
  }

  // --- 圖片 ---
  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        await this.handleStainAnalysis(userId, buffer);
        delete this.userState[userId];
      }
    } catch (err) {
      logger.logError("圖片處理錯誤", err, userId);
      await client.pushMessage(userId, { type: "text", text: "服務暫時不可用，請稍後再試 🙏" });
    }
  }

  // --- 查詢進度 ---
  isProgressQuery(text) {
    return ["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"].some((k) => text.includes(k));
  }

  async handleProgressQuery(userId) {
    await client.pushMessage(userId, {
      type: "text",
      text: "您可以這邊線上查詢 C.H精緻洗衣 🔍",
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "uri",
              label: "查詢進度",
              uri: "https://liff.line.me/2004612704-JnzA1qN6",
            },
          },
        ],
      },
    });
  }

  // --- 地址訊息 ---
  async handleAddressMessage(userId, address) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } = AddressDetector.formatResponse(address);

      const customerInfo = { userId, userName: profile.displayName, address: formattedAddress };
      await addCustomerInfo(customerInfo);

      await client.pushMessage(userId, { type: "text", text: response });
    } catch (err) {
      logger.logError("處理地址錯誤", err, userId);
      await client.pushMessage(userId, { type: "text", text: "抱歉，處理地址時出現錯誤，請稍後再試 🙏" });
    }
  }
}

module.exports = new MessageHandler();
