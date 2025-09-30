// services/message.js
const { Client } = require('@line/bot-sdk');
const { analyzeStainWithAI, smartAutoReply } = require('./openai');
const { createHash } = require('crypto');
const logger = require('./logger');
const AddressDetector = require('../utils/address');       // 你原本的地址工具（isAddress/formatResponse）
const { addCustomerInfo } = require('./google');           // 若你有接 Google Sheet，就會用到

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 可視需要調整
const CHECK_STATUS_URL = process.env.CHECK_STATUS_URL || "https://liff.line.me/2004612704-JnzA1qN6#/";

// 強制不回應關鍵詞（保留你原本的）
const ignoredKeywords = [
  "常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間",
  "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析",
  "謝謝", "您好", "按錯"
];

// 將全形數字轉半形、去頭尾空白
function normalizeText(input = '') {
  const fw = '０１２３４５６７８９';
  const hw = '0123456789';
  let out = (input || '').trim();
  out = out.replace(/[０-９]/g, ch => hw[fw.indexOf(ch)]);
  return out;
}

class MessageHandler {
  constructor() {
    this.userState = {};
  }

  // 文字訊息（務必從 webhook 呼叫時傳入 replyToken）
  async handleTextMessage(userId, text, originalMessage, replyToken) {
    const rawText = text || '';
    const normText = normalizeText(rawText);
    const lowerText = normText.toLowerCase();

    // 忽略類訊息
    if (ignoredKeywords.some(k => lowerText.includes(k.toLowerCase()))) {
      logger.logToFile(`[Ignored] ${userId}: ${normText}`);
      return;
    }

    // 「1」→ 啟動污漬分析
    if (/^[1]$/.test(normText)) {
      return this.handleNumberOneCommand(userId, replyToken);
    }

    // 地址直接回覆（維持你原本的 AddressDetector 邏輯與寫入 Sheets）
    if (AddressDetector?.isAddress && AddressDetector.isAddress(normText)) {
      return this.handleAddressMessage(userId, normText, replyToken);
    }

    // 進度查詢（保留本地判斷一次，能即時回）
    if (/(洗好|洗好了嗎|可以拿了嗎|進度|完成了嗎|查進度|查詢進度)/.test(normText)) {
      return this.handleProgressQuery(userId, replyToken);
    }

    // 其他 → 交給 AI 高度判斷（內含規則覆蓋、付款/收件/時間/兒童用品等）
    try {
      const aiText = await smartAutoReply(normText);
      if (aiText) {
        await client.replyMessage(replyToken, { type: 'text', text: aiText });
        logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
      } else {
        logger.logToFile(`[AI empty] ${userId}: ${normText}`);
      }
    } catch (err) {
      logger.logError('smartAutoReply 錯誤', err, userId);
    }
  }

  // 圖片訊息
  async handleImageMessage(userId, messageId) {
    try {
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (this.userState[userId]?.waitingForImage) {
        // 先記錄 hash
        const imageHash = createHash('sha256').update(buffer).digest('hex');
        logger.logToFile(`圖片已接收，hash: ${imageHash}`);

        // 直接做 AI 污漬分析（分析結果較長，用 push）
        const analysisResult = await analyzeStainWithAI(buffer);
        await client.pushMessage(userId, {
          type: 'text',
          text: `${analysisResult}\n\n✨ 智能分析完成 👕`
        });

        delete this.userState[userId];
      } else {
        logger.logToFile(`[Image ignored] user ${userId} 未在等待圖片`);
      }
    } catch (err) {
      logger.logError('handleImageMessage 錯誤', err, userId);
      await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
  }

  // 啟動污漬分析
  async handleNumberOneCommand(userId, replyToken) {
    try {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '請上傳照片，以進行智能污漬分析✨📷'
      });
      this.userState[userId] = { waitingForImage: true };
      logger.logToFile(`[StainAnalysis] Ask upload → user ${userId}`);
    } catch (err) {
      // replyToken 若過期 → 改用 push
      logger.logToFile(`[StainAnalysis] reply 失敗，改用 push。`);
      await client.pushMessage(userId, {
        type: 'text',
        text: '請上傳照片，以進行智能污漬分析✨📷'
      });
      this.userState[userId] = { waitingForImage: true };
    }
  }

  // 進度查詢（固定回連結）
  async handleProgressQuery(userId, replyToken) {
    try {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '您可以這邊線上查詢 C.H 精緻洗衣 🔍',
        quickReply: {
          items: [{
            type: "action",
            action: { type: "uri", label: "查詢進度", uri: CHECK_STATUS_URL }
          }]
        }
      });
    } catch (err) {
      // 退而求其次 push
      await client.pushMessage(userId, {
        type: 'text',
        text: `您可以這邊線上查詢 C.H 精緻洗衣 🔍\n👉 ${CHECK_STATUS_URL}`
      });
    }
  }

  // 地址訊息（寫入 Google Sheet；回覆「會安排收件 + 地址」）
  async handleAddressMessage(userId, addressText, replyToken) {
    try {
      const profile = await client.getProfile(userId);
      const { formattedAddress, response } =
        AddressDetector.formatResponse
          ? AddressDetector.formatResponse(addressText)
          : { formattedAddress: addressText, response: `好的 😊 我們會安排到府收件\n地址：${addressText}` };

      // 寫入 Google Sheets（若你有配置）
      try {
        if (addCustomerInfo) {
          await addCustomerInfo({ userId, userName: profile.displayName, address: formattedAddress });
        }
      } catch (sheetErr) {
        logger.logError('寫入 Google Sheets 失敗（可忽略）', sheetErr, userId);
      }

      await client.replyMessage(replyToken, { type: 'text', text: response });
      logger.logBotResponse(userId, addressText, response, 'Bot (Address)');
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
