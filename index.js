// ============== 引入依賴 ==============
const fs = require('fs');
const express = require('express');
require('dotenv').config();
const logger = require('./services/logger');
const messageHandler = require('./services/message');
const { Client } = require('@line/bot-sdk');

console.log(`正在初始化 sheet.json: ${process.env.GOOGLE_PRIVATE_KEY ? '成功' : '失敗'}`);
fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
console.log(`sheet.json 初始化结束`);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ 靜態文件支援（網頁管理介面）
app.use(express.static('public'));

// ============== LINE Client（推播用）===============
const client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
    res.status(200).end();
    try {
        const events = req.body.events;
        for (const event of events) {
            try {
                if (event.type !== 'message' || !event.source.userId) continue;
                const userId = event.source.userId;
                console.log("[DEBUG] userId =", userId);
                let userMessage = '';
                
                if (event.message.type === 'text') {
                    userMessage = event.message.text.trim();
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleTextMessage(userId, userMessage, userMessage);
                } else if (event.message.type === 'image') {
                    userMessage = '上傳了一張圖片';
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleImageMessage(userId, event.message.id);
                } else {
                    userMessage = '發送了其他類型的訊息';
                    logger.logUserMessage(userId, userMessage);
                }
            } catch (err) {
                logger.logError('處理事件時出錯', err, event.source?.userId);
            }
        }
    } catch (err) {
        logger.logError('全局錯誤', err);
    }
});

// ============== 下載日誌文件 ==============
app.get('/log', (req, res) => {
    res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
        if (err) {
            logger.logError('下載日誌文件出錯', err);
            res.status(500).send('下載文件失敗');
        }
    });
});

// ============== 測試推播路由 ==============
app.get('/test-push', async (req, res) => {
    const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx";
    try {
        await client.pushMessage(userId, {
            type: 'text',
            text: '✅ 測試推播成功！這是一則主動訊息 🚀'
        });
        res.send("推播成功，請查看 LINE Bot 訊息");
    } catch (err) {
        console.error("推播錯誤", err);
        res.status(500).send(`推播失敗: ${err.message}`);
    }
});

// ============== 📱 發送付款連結 API ==============
app.post('/send-payment', async (req, res) => {
    const { userId, userName, amount, paymentType } = req.body;
    
    logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);
    
    // 參數驗證
    if (!userId || !userName || !amount) {
        logger.logToFile(`❌ 參數驗證失敗: userId=${userId}, userName=${userName}, amount=${amount}`);
        return res.status(400).json({ 
            error: '缺少必要參數',
            required: ['userId', 'userName', 'amount'],
            received: { userId, userName, amount },
            example: {
                userId: "U1234567890abcdef",
                userName: "王小明",
                amount: 1500,
                paymentType: "ecpay"
            }
        });
    }

    // 金額驗證
    const numAmount = parseInt(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
        logger.logToFile(`❌ 金額驗證失敗: ${amount}`);
        return res.status(400).json({ error: '金額必須是正整數' });
    }

    try {
        const { createECPayPaymentLink } = require('./services/openai');
        let paymentLink = '';
        let message = '';
        const type = paymentType || 'ecpay';

        if (type === 'ecpay') {
            // ✅ 綠界付款（動態金額）
            paymentLink = createECPayPaymentLink(userId, userName, numAmount);
            message = `💳 您好，${userName}\n\n` +
                     `您的專屬付款連結已生成\n` +
                     `付款方式：信用卡/超商/ATM\n` +
                     `金額：NT$ ${numAmount.toLocaleString()}\n\n` +
                     `請點擊以下連結完成付款：\n${paymentLink}\n\n` +
                     `✅ 付款後系統會自動通知我們\n` +
                     `感謝您的支持 💙`;
        } else if (type === 'linepay') {
            // ✅ LINE Pay（固定連結）
            const LINE_PAY_URL = process.env.LINE_PAY_URL;
            if (!LINE_PAY_URL) {
                return res.status(500).json({ error: 'LINE Pay 連結未設定' });
            }
            message = `💚 您好，${userName}\n\n` +
                     `請使用 LINE Pay 付款\n` +
                     `金額：NT$ ${numAmount.toLocaleString()}\n\n` +
                     `付款連結：\n${LINE_PAY_URL}\n\n` +
                     `⚠️ 請確認付款金額為 NT$ ${numAmount}\n` +
                     `完成付款後請告知我們，謝謝 😊`;
        } else {
            return res.status(400).json({ error: '不支援的付款方式，請使用 ecpay 或 linepay' });
        }
        
        // 發送給客戶
        logger.logToFile(`📤 準備發送訊息給 ${userId}: ${message.substring(0, 50)}...`);
        
        await client.pushMessage(userId, {
            type: 'text',
            text: message
        });
        
        logger.logToFile(`✅ 已發送${type === 'linepay' ? 'LINE Pay' : '綠界'}付款連結: ${userName} (${userId}) - ${numAmount}元`);
        
        res.json({ 
            success: true, 
            message: '付款連結已發送',
            data: {
                userId,
                userName,
                amount: numAmount,
                paymentType: type,
                link: type === 'ecpay' ? paymentLink : LINE_PAY_URL
            }
        });
    } catch (err) {
        logger.logError('發送付款連結失敗', err);
        console.error('❌ 詳細錯誤:', err);
        res.status(500).json({ 
            error: '發送失敗', 
            details: err.message 
        });
    }
});

// ============== 💰 綠界付款回調（自動通知）==============
app.post('/payment/ecpay/callback', async (req, res) => {
    try {
        logger.logToFile(`收到綠界回調: ${JSON.stringify(req.body)}`);
        
        const { 
            MerchantTradeNo,
            RtnCode,
            RtnMsg,
            TradeAmt,
            PaymentDate,
            PaymentType,
            CustomField1: userId,
            CustomField2: userName
        } = req.body;

        // ✅ 驗證付款成功
        if (RtnCode === '1') {
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            
            // 通知店家（你）
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, {
                    type: 'text',
                    text: `🎉 收到付款通知\n\n` +
                          `客戶姓名：${userName}\n` +
                          `付款金額：NT$ ${parseInt(TradeAmt).toLocaleString()}\n` +
                          `付款方式：${getPaymentTypeName(PaymentType)}\n` +
                          `付款時間：${PaymentDate}\n` +
                          `訂單編號：${MerchantTradeNo}\n\n` +
                          `狀態：✅ 付款成功`
                });
            }

            // 通知客戶
            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: `✅ 付款成功\n\n` +
                          `感謝 ${userName} 的支付\n` +
                          `金額：NT$ ${parseInt(TradeAmt).toLocaleString()}\n` +
                          `訂單編號：${MerchantTradeNo}\n\n` +
                          `我們會盡快處理您的訂單\n` +
                          `感謝您的支持 💙`
                });
            }

            logger.logToFile(`✅ 付款成功: ${userName} - ${TradeAmt}元 - 訂單${MerchantTradeNo}`);
        } else {
            logger.logToFile(`❌ 付款異常: 訂單${MerchantTradeNo} - ${RtnMsg}`);
        }

        res.send('1|OK');
    } catch (err) {
        logger.logError('處理綠界回調失敗', err);
        res.send('0|ERROR');
    }
});

// ============== 工具函數：付款方式名稱 ==============
function getPaymentTypeName(code) {
    const types = {
        'Credit_CreditCard': '信用卡',
        'ATM_LAND': 'ATM 轉帳',
        'CVS_CVS': '超商代碼',
        'BARCODE_BARCODE': '超商條碼',
        'WebATM_TAISHIN': '網路 ATM',
    };
    return types[code] || code;
}

// ============== 🎨 付款管理網頁 ==============
app.get('/payment', (req, res) => {
    res.sendFile(__dirname + '/public/payment.html');
});

// ============== 🔍 查詢付款狀態（選用）==============
app.get('/payment/status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    res.json({
        message: '付款狀態查詢功能（待實作）',
        orderId
    });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行，端口：${PORT}`);
    logger.logToFile(`伺服器正在運行，端口：${PORT}`);
});
