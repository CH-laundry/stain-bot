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

// 靜態文件支援
app.use(express.static('public'));

// ============== LINE Client ==============
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

// ============== 綠界付款跳轉頁面 ==============
app.get('/payment/redirect', (req, res) => {
    const { data } = req.query;
    
    if (!data) {
        return res.status(400).send('缺少付款資料');
    }
    
    try {
        const paymentData = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
        
        const formHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>跳轉到綠界付款</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 50px; }
        .loading { font-size: 18px; color: #666; }
    </style>
</head>
<body>
    <h3 class="loading">正在跳轉到付款頁面...</h3>
    <p>請稍候，若未自動跳轉請點擊下方按鈕</p>
    <form id="ecpayForm" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">
        ${Object.keys(paymentData).map(key => 
            `<input type="hidden" name="${key}" value="${paymentData[key]}">`
        ).join('\n')}
        <button type="submit" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">前往付款</button>
    </form>
    <script>
        setTimeout(function() {
            document.getElementById('ecpayForm').submit();
        }, 500);
    </script>
</body>
</html>
        `;
        
        res.send(formHTML);
        
    } catch (error) {
        logger.logError('付款跳轉失敗', error);
        res.status(500).send('付款連結錯誤');
    }
});

// ============== 付款成功返回頁面 ==============
app.get('/payment/success', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>付款完成</title>
    <style>
        body { 
            font-family: sans-serif; 
            text-align: center; 
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        h1 { color: #fff; font-size: 32px; }
        p { font-size: 18px; }
        .container {
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            margin: 0 auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ 付款已完成</h1>
        <p>感謝您的支付，我們會盡快處理您的訂單</p>
        <p>您可以關閉此頁面了</p>
    </div>
</body>
</html>
    `);
});

// ============== 發送付款連結 API ==============
app.post('/send-payment', async (req, res) => {
    const { userId, userName, amount, paymentType } = req.body;
    
    logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);
    
    if (!userId || !userName || !amount) {
        logger.logToFile(`❌ 參數驗證失敗`);
        return res.status(400).json({ 
            error: '缺少必要參數',
            required: ['userId', 'userName', 'amount']
        });
    }

    const numAmount = parseInt(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: '金額必須是正整數' });
    }

    try {
        const { createECPayPaymentLink } = require('./services/openai');
        let paymentLink = '';
        let message = '';
        const type = paymentType || 'ecpay';

        if (type === 'ecpay') {
            paymentLink = createECPayPaymentLink(userId, userName, numAmount);
            message = `💳 您好，${userName}\n\n您的專屬付款連結已生成\n付款方式：信用卡/超商/ATM\n金額：NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款：\n${paymentLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else if (type === 'linepay') {
            const LINE_PAY_URL = process.env.LINE_PAY_URL;
            if (!LINE_PAY_URL) {
                return res.status(500).json({ error: 'LINE Pay 連結未設定' });
            }
            message = `💚 您好，${userName}\n\n請使用 LINE Pay 付款\n金額：NT$ ${numAmount.toLocaleString()}\n\n付款連結：\n${LINE_PAY_URL}\n\n⚠️ 請確認付款金額為 NT$ ${numAmount}\n完成付款後請告知我們，謝謝 😊`;
        } else {
            return res.status(400).json({ error: '不支援的付款方式' });
        }
        
        await client.pushMessage(userId, { type: 'text', text: message });
        logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount}元`);
        
        res.json({ 
            success: true, 
            message: '付款連結已發送',
            data: { userId, userName, amount: numAmount, paymentType: type, link: type === 'ecpay' ? paymentLink : LINE_PAY_URL }
        });
    } catch (err) {
        logger.logError('發送付款連結失敗', err);
        res.status(500).json({ error: '發送失敗', details: err.message });
    }
});

// ============== 綠界付款回調 ==============
app.post('/payment/ecpay/callback', async (req, res) => {
    try {
        logger.logToFile(`收到綠界回調: ${JSON.stringify(req.body)}`);
        
        const { MerchantTradeNo, RtnCode, RtnMsg, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body;

        if (RtnCode === '1') {
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, {
                    type: 'text',
                    text: `🎉 收到付款通知\n\n客戶姓名：${userName}\n付款金額：NT$ ${parseInt(TradeAmt).toLocaleString()}\n付款方式：${getPaymentTypeName(PaymentType)}\n付款時間：${PaymentDate}\n訂單編號：${MerchantTradeNo}\n\n狀態：✅ 付款成功`
                });
            }

            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額：NT$ ${parseInt(TradeAmt).toLocaleString()}\n訂單編號：${MerchantTradeNo}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙`
                });
            }

            logger.logToFile(`✅ 付款成功: ${userName} - ${TradeAmt}元`);
        } else {
            logger.logToFile(`❌ 付款異常: ${RtnMsg}`);
        }

        res.send('1|OK');
    } catch (err) {
        logger.logError('處理綠界回調失敗', err);
        res.send('0|ERROR');
    }
});

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

// ============== 付款管理網頁 ==============
app.get('/payment', (req, res) => {
    res.sendFile(__dirname + '/public/payment.html');
});

app.get('/payment/status/:orderId', async (req, res) => {
    res.json({ message: '付款狀態查詢功能（待實作）', orderId: req.params.orderId });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行，端口：${PORT}`);
    logger.logToFile(`伺服器正在運行，端口：${PORT}`);
});
