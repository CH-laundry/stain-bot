
// ✅ 此為整合後的完整 message.js（語意搜尋 + GPT + 查詢進度 + 學習）
const { Client } = require('@line/bot-sdk');
const { detectInquiryType } = require('../inquiryType');
const { analyzeStainWithAI, getAIResponse } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');
const { isProgressQuery, getProgressReply } = require('./progressDetector');
const { findSimilarAnswer } = require('./semanticSearch');

// 初始化 LINE 客户端
const client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
});

const ignoredKeywords = [
    "常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", 
    "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析", 
    "謝謝", "您好", "按錯"
];

class MessageHandler {
    constructor() {
        this.userState = {};
        this.store = new Map();
        this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
        this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
    }

    isLaundryRelatedText(text) {
        const lowerText = text.toLowerCase();
        const keywords = [
            "洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色",
            "地毯", "窗簾", "汽座", "安全兒童座椅", "手推車", "書包",
            "營業", "收送", "到府", "收衣", "預約"
        ];
        return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
    }

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

    async handleStainAnalysis(userId, imageBuffer) {
        try {
            const imageHash = createHash('sha256').update(imageBuffer).digest('hex');
            logger.logToFile(`圖片已接收，hash值: ${imageHash}`);

            const analysisResult = await analyzeStainWithAI(imageBuffer);
            await client.pushMessage(userId, {
                type: 'text',
                text: `${analysisResult}

✨ 智能分析完成 👕`
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

    async handleTextMessage(userId, text, originalMessage) {
        const lowerText = text.toLowerCase();

        if (ignoredKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
            logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。(User ID: ${userId})`);
            return;
        }

        if (AddressDetector.isAddress(text)) {
            await this.handleAddressMessage(userId, text);
            return;
        }

        if (text === '1') {
            return this.handleNumberOneCommand(userId);
        }

        if (isProgressQuery(text)) {
            await client.pushMessage(userId, getProgressReply());
            return;
        }

        const inquiryResult = detectInquiryType(text);
        if (inquiryResult) {
            await client.pushMessage(userId, {
                type: 'text',
                text: inquiryResult
            });
            logger.logBotResponse(userId, originalMessage, inquiryResult);
            return;
        }

        if (this.isLaundryRelatedText(text)) {
            await this.handleAIResponse(userId, text, originalMessage);

            // 🔁 如果 AI 回覆未能正確處理，再語意比對 fallback
            const similarAnswer = await findSimilarAnswer(text);
            if (similarAnswer) {
                await client.pushMessage(userId, { type: 'text', text: similarAnswer });
                logger.logBotResponse(userId, originalMessage, similarAnswer, 'Bot (語意搜尋)');
                return;
            }

            const aiReply = await getAIResponse(text);
            if (aiReply && !aiReply.includes("無法回答")) {
                await client.pushMessage(userId, { type: 'text', text: aiReply });
                logger.logBotResponse(userId, originalMessage, aiReply, 'Bot (AI)');
            }
        } else {
            logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，不使用AI回應。(User ID: ${userId})`);
        }
    }

    async handleImageMessage(userId, messageId) {
        try {
            logger.logToFile(`收到圖片訊息 from ${userId}，正在處理...`);
            const stream = await client.getMessageContent(messageId);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            if (this.userState[userId]?.waitingForImage) {
                await this.handleStainAnalysis(userId, buffer);
                delete this.userState[userId];
            }
        } catch (err) {
            logger.logError('處理圖片時出錯', err, userId);
            await client.pushMessage(userId, { 
                type: 'text', 
                text: '圖片處理失敗，請稍後再試。' 
            });
        }
    }

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
            await client.pushMessage(userId, {
                type: 'text',
                text: response
            });
            logger.logBotResponse(userId, address, response, 'Bot (Address)');
        } catch (error) {
            logger.logError('地址處理錯誤', error, userId);
            await client.pushMessage(userId, {
                type: 'text',
                text: '地址處理時發生問題，請稍後再試。'
            });
        }
    }

    async handleAIResponse(userId, text, originalMessage) {
        try {
            const aiText = await getAIResponse(text);
            if (!aiText || aiText.includes('無法回答')) return;
            await client.pushMessage(userId, { type: 'text', text: aiText });
            logger.logBotResponse(userId, originalMessage, aiText, 'Bot (AI)');
        } catch (error) {
            logger.logError('AI 回應錯誤', error, userId);
        }
    }
}

module.exports = new MessageHandler();
