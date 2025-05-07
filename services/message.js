const { Client } = require('@line/bot-sdk');
const { detectInquiryType } = require('../inquiryType');
const { analyzeStainWithAI, getAIResponse } = require('./openai');
const logger = require('./logger');
const { createHash } = require('crypto');
const AddressDetector = require('../utils/address');
const { addCustomerInfo } = require('./google');
const { recordUnansweredQuestion } = require('../googleSheets');

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
        this.MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
        this.MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800;
    }

    isLaundryRelatedText(text) {
        const lowerText = text.toLowerCase();
        const keywords = [
            "洗衣", "清洗", "污漬", "油漬", "血漬", "染色", "退色",
            "衣服", "衣物", "褲子", "大衣", "羽絨", "西裝",
            "鞋", "鞋子", "球鞋", "皮鞋", "靴子", "拖鞋", "運動鞋",
            "包", "包包", "書包", "名牌包", "精品包",
            "窗簾", "地毯", "寶寶汽座", "嬰兒汽座", "手推車",
            "收送", "收衣", "到府", "預約", "開門", "休息", "營業", "送洗"
        ];
        return keywords.some(keyword => lowerText.includes(keyword));
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

        if (this.isProgressQuery(lowerText)) {
            return this.handleProgressQuery(userId);
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

        console.log(`[AI檢查] 是否進入 GPT 回答：${this.isLaundryRelatedText(text)} | 訊息：「${text}」`);

        if (this.isLaundryRelatedText(text)) {
            await this.handleAIResponse(userId, text, originalMessage);
        } else {
            logger.logToFile(`用戶 ${userId} 的訊息與洗衣店無關，不使用AI回應。(User ID: ${userId})`);
        }
    }

    async handleImageMessage(userId, messageId) {
        try {
            logger.logToFile(`收到來自 ${userId} 的圖片訊息, 正在處理...(User ID: ${userId})`);

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
                text: '服務暫時不可用，請稍後再試。' 
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
        logger.logToFile(`Bot 回覆用戶 ${userId}: 請上傳照片，以進行智能污漬分析✨📷(User ID: ${userId})`);
    }

    isProgressQuery(text) {
        const progressKeywords = ["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"];
        return progressKeywords.some(k => text.includes(k));
    }

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

    async handleAIResponse(userId, text, originalMessage) {
        try {
            const aiText = await getAIResponse(text);
            if (!aiText || aiText.includes('無法回答')) {
                logger.logToFile(`無法回答的問題: ${text}(User ID: ${userId})`);
                await recordUnansweredQuestion(text, userId);
                await client.pushMessage(userId, {
                    type: 'text',
                    text: '這個問題我還沒學會，小編會補上答案唷 😊'
                });
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

    async handleAddressMessage(userId, address) {
        try {
            const profile = await client.getProfile(userId);
            const { formattedAddress, response } = AddressDetector.formatResponse(address);
            const customerInfo = {
                userId: userId,
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
            logger.logError('處理地址訊息時出錯', error, userId);
            await client.pushMessage(userId, {
                type: 'text',
                text: '抱歉，處理您的地址時出現錯誤，請稍後再試。'
            });
        }
    }
}

module.exports = new MessageHandler();
