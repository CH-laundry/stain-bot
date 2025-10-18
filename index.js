require('dotenv').config();
const line = require('@line/bot-sdk');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createECPayPayment = require('./services/ecpay');
const createLinePayPayment = require('./services/linepay');
const orderManager = require('./services/orderManager');
const customerDB = require('./services/customerDB');
const logger = require('./services/logger');

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Webhook 路由
app.post('/webhook', line.middleware(config), async (req, res) => {
    try {
        const events = req.body.events;
        await Promise.all(events.map(handleEvent));
        res.status(200).send('OK');
    } catch (err) {
        logger.logError('Webhook 處理失敗', err);
        res.status(500).end();
    }
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return null;
    }

    const userId = event.source.userId;
    const userMessage = event.message.text.trim();

    try {
        const profile = await client.getProfile(userId);
        const userName = profile.displayName;

        await customerDB.addOrUpdateCustomer({
            userId: userId,
            userName: userName,
            lastInteraction: Date.now()
        });

        logger.logToFile(`收到訊息 - 用戶: ${userName} (${userId}), 內容: ${userMessage}`);

        let replyMessage = '';

        if (userMessage === '查詢餘額' || userMessage === '餘額') {
            const customer = customerDB.getCustomer(userId);
            if (customer && customer.balance !== undefined) {
                replyMessage = `您目前的餘額為: NT$ ${customer.balance}`;
            } else {
                replyMessage = '查無餘額資訊';
            }
        } else if (userMessage === '查詢訂單' || userMessage === '訂單') {
            const orders = orderManager.getAllOrders().filter(order => order.userId === userId);
            if (orders.length === 0) {
                replyMessage = '您目前沒有訂單';
            } else {
                const pendingOrders = orders.filter(o => o.status === 'pending' && !orderManager.isExpired(o.orderId));
                const paidOrders = orders.filter(o => o.status === 'paid');
                
                replyMessage = `📋 您的訂單狀態:\n\n`;
                replyMessage += `待付款: ${pendingOrders.length} 筆\n`;
                replyMessage += `已付款: ${paidOrders.length} 筆\n\n`;
                
                if (pendingOrders.length > 0) {
                    replyMessage += `最新待付款訂單:\n`;
                    const latestOrder = pendingOrders[0];
                    const remainingHours = Math.floor((latestOrder.expiryTime - Date.now()) / (1000 * 60 * 60));
                    replyMessage += `金額: NT$ ${latestOrder.amount}\n`;
                    replyMessage += `剩餘時間: ${remainingHours} 小時`;
                }
            }
        } else if (userMessage === '付款說明' || userMessage === '說明') {
            replyMessage = `📱 付款說明:\n\n`;
            replyMessage += `1. 我們會發送付款連結給您\n`;
            replyMessage += `2. 點擊連結選擇付款方式\n`;
            replyMessage += `3. 完成付款即可\n\n`;
            replyMessage += `💡 可用指令:\n`;
            replyMessage += `• 查詢餘額\n`;
            replyMessage += `• 查詢訂單\n`;
            replyMessage += `• 付款說明`;
        } else if (userMessage === '測試付款') {
            replyMessage = `此功能已停用,請聯繫客服發送付款連結`;
        } else {
            replyMessage = `您好 ${userName}!\n\n`;
            replyMessage += `💡 可用指令:\n`;
            replyMessage += `• 查詢餘額\n`;
            replyMessage += `• 查詢訂單\n`;
            replyMessage += `• 付款說明`;
        }

        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: replyMessage }]
        });

    } catch (error) {
        logger.logError('處理訊息時發生錯誤', error);
    }
}

// 發送付款連結
app.post('/send-payment', async (req, res) => {
    try {
        const { userId, userName, amount, paymentMethod = 'both' } = req.body;

        if (!userId || !userName || !amount) {
            return res.json({ success: false, message: '缺少必要參數' });
        }

        logger.logToFile(`發送付款請求 - 用戶: ${userName}, 金額: ${amount}, 方式: ${paymentMethod}`);

        const messages = [];
        let ecpayOrderId, linepayOrderId;

        if (paymentMethod === 'both' || paymentMethod === 'ecpay') {
            ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
            orderManager.createOrder(ecpayOrderId, { userId, userName, amount });
            
            const ecpayUrl = `https://stain-bot-production-2593.up.railway.app/payment/ecpay/pay/${ecpayOrderId}`;
            
            messages.push({
                type: 'text',
                text: `💳 綠界 ECPay 付款連結:\n金額: NT$ ${amount}\n\n點擊下方連結付款 👇`
            });
            messages.push({
                type: 'text',
                text: ecpayUrl
            });

            logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);
        }

        if (paymentMethod === 'both' || paymentMethod === 'linepay') {
            linepayOrderId = `LP${Date.now()}${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
            orderManager.createOrder(linepayOrderId, { userId, userName, amount });
            
            const linepayUrl = `https://stain-bot-production-2593.up.railway.app/payment/linepay/pay/${linepayOrderId}`;
            
            messages.push({
                type: 'text',
                text: `💚 LINE Pay 付款連結:\n金額: NT$ ${amount}\n\n點擊下方連結付款 👇`
            });
            messages.push({
                type: 'text',
                text: linepayUrl
            });

            logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linepayOrderId}`);
        }

        await client.pushMessage({
            to: userId,
            messages: messages
        });

        res.json({ 
            success: true, 
            message: '付款連結已發送',
            ecpayOrderId,
            linepayOrderId
        });

    } catch (error) {
        logger.logError('發送付款連結失敗', error);
        res.json({ success: false, message: error.message });
    }
});
// LINE Pay 付款路由
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = orderManager.getOrder(orderId);

        if (!order) {
            return res.status(404).send('訂單不存在');
        }

        if (orderManager.isExpired(orderId)) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>訂單已過期</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                        h1 { color: #dc3545; }
                        p { color: #666; font-size: 18px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>⏰ 訂單已過期</h1>
                        <p>此付款連結已失效</p>
                        <p>請聯繫客服取得新的付款連結</p>
                    </div>
                </body>
                </html>
            `);
        }

        if (order.status === 'paid') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>已付款</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                        h1 { color: #28a745; }
                        p { color: #666; font-size: 18px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ 已完成付款</h1>
                        <p>此訂單已經付款完成</p>
                        <p>感謝您的支持!</p>
                    </div>
                </body>
                </html>
            `);
        }

        const paymentData = await createLinePayPayment(orderId, order.amount, order.userName);
        
        orderManager.updatePaymentInfo(orderId, paymentData.transactionId, paymentData.paymentUrl);

        res.redirect(paymentData.paymentUrl);

    } catch (error) {
        logger.logError('LINE Pay 付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});

app.get('/payment/linepay/confirm', async (req, res) => {
    try {
        const { transactionId, orderId } = req.query;

        logger.logToFile(`LINE Pay 確認付款 - 訂單: ${orderId}, 交易: ${transactionId}`);

        const order = orderManager.getOrder(orderId);

        if (!order) {
            return res.status(404).send('訂單不存在');
        }

        if (order && orderManager.isExpired(orderId)) {
            return res.send('訂單已過期');
        }

        const axios = require('axios');
        const confirmUrl = `https://sandbox-api-pay.line.me/v3/payments/${transactionId}/confirm`;
        
        const confirmBody = {
            amount: order.amount,
            currency: 'TWD'
        };

        const channelSecret = process.env.LINE_PAY_CHANNEL_SECRET;
        const nonce = crypto.randomBytes(16).toString('base64');
        const signature = crypto
            .createHmac('SHA256', channelSecret)
            .update(channelSecret + '/v3/payments/' + transactionId + '/confirm' + JSON.stringify(confirmBody) + nonce)
            .digest('base64');

        const response = await axios.post(confirmUrl, confirmBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': process.env.LINE_PAY_CHANNEL_ID,
                'X-LINE-Authorization-Nonce': nonce,
                'X-LINE-Authorization': signature
            }
        });

        if (response.data.returnCode === '0000') {
            orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
            logger.logToFile(`✅ LINE Pay 付款成功 - 訂單: ${orderId}`);

            await client.pushMessage({
                to: order.userId,
                messages: [{
                    type: 'text',
                    text: `✅ 付款成功!\n\n訂單編號: ${orderId}\n金額: NT$ ${order.amount}\n付款方式: LINE Pay\n\n感謝您的支付!`
                }]
            });

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款成功</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                        .container { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); max-width: 500px; margin: 0 auto; }
                        h1 { color: #28a745; font-size: 32px; margin-bottom: 20px; }
                        .checkmark { font-size: 80px; color: #28a745; margin: 20px 0; }
                        p { color: #666; font-size: 18px; margin: 10px 0; }
                        .amount { font-size: 36px; color: #667eea; font-weight: bold; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="checkmark">✓</div>
                        <h1>付款成功!</h1>
                        <div class="amount">NT$ ${order.amount}</div>
                        <p>訂單編號: ${orderId}</p>
                        <p>付款方式: LINE Pay</p>
                        <p style="margin-top: 30px; color: #999;">感謝您的支持!</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            throw new Error('LINE Pay 確認失敗');
        }

    } catch (error) {
        logger.logError('LINE Pay 確認失敗', error);
        res.status(500).send('付款確認失敗');
    }
});

// 綠界 ECPay 付款路由
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = orderManager.getOrder(orderId);

        if (!order) {
            return res.status(404).send('訂單不存在');
        }

        if (orderManager.isExpired(orderId)) {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>訂單已過期</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                        h1 { color: #dc3545; }
                        p { color: #666; font-size: 18px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>⏰ 訂單已過期</h1>
                        <p>此付款連結已失效</p>
                        <p>請聯繫客服取得新的付款連結</p>
                    </div>
                </body>
                </html>
            `);
        }

        if (order.status === 'paid') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>已付款</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                        h1 { color: #28a745; }
                        p { color: #666; font-size: 18px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ 已完成付款</h1>
                        <p>此訂單已經付款完成</p>
                        <p>感謝您的支持!</p>
                    </div>
                </body>
                </html>
            `);
        }

        const paymentHtml = createECPayPayment(orderId, order.amount, order.userName);
        res.send(paymentHtml);

    } catch (error) {
        logger.logError('綠界付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});
app.post('/payment/ecpay/callback', async (req, res) => {
    try {
        logger.logToFile('收到綠界回調: ' + JSON.stringify(req.body));

        const { MerchantTradeNo, RtnCode, CheckMacValue } = req.body;

        if (RtnCode === '1') {
            const order = orderManager.getOrder(MerchantTradeNo);
            
            if (order) {
                orderManager.updateOrderStatus(MerchantTradeNo, 'paid', 'ECPay');
                logger.logToFile(`✅ 綠界付款成功 - 訂單: ${MerchantTradeNo}`);

                await client.pushMessage({
                    to: order.userId,
                    messages: [{
                        type: 'text',
                        text: `✅ 付款成功!\n\n訂單編號: ${MerchantTradeNo}\n金額: NT$ ${order.amount}\n付款方式: 綠界 ECPay\n\n感謝您的支付!`
                    }]
                });
            }
        }

        res.send('1|OK');
    } catch (error) {
        logger.logError('綠界回調處理失敗', error);
        res.send('0|Error');
    }
});

app.post('/payment/ecpay/return', async (req, res) => {
    try {
        const { MerchantTradeNo, RtnCode } = req.body;
        const order = orderManager.getOrder(MerchantTradeNo);

        if (RtnCode === '1' && order) {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款成功</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                        .container { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); max-width: 500px; margin: 0 auto; }
                        h1 { color: #28a745; font-size: 32px; margin-bottom: 20px; }
                        .checkmark { font-size: 80px; color: #28a745; margin: 20px 0; }
                        p { color: #666; font-size: 18px; margin: 10px 0; }
                        .amount { font-size: 36px; color: #667eea; font-weight: bold; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="checkmark">✓</div>
                        <h1>付款成功!</h1>
                        <div class="amount">NT$ ${order.amount}</div>
                        <p>訂單編號: ${MerchantTradeNo}</p>
                        <p>付款方式: 綠界 ECPay</p>
                        <p style="margin-top: 30px; color: #999;">感謝您的支持!</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.send('付款失敗');
        }
    } catch (error) {
        logger.logError('綠界返回處理失敗', error);
        res.status(500).send('處理失敗');
    }
});

// API 路由
app.get('/api/customers', (req, res) => {
    const customers = customerDB.getAllCustomers();
    res.json(customers);
});

app.get('/api/orders', (req, res) => {
    const orders = orderManager.getAllOrders();
    const ordersWithStatus = orders.map(order => ({
        ...order,
        isExpired: Date.now() > order.expiryTime,
        remainingTime: Math.max(0, order.expiryTime - Date.now()),
        remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
    }));
    res.json(ordersWithStatus);
});

app.get('/api/order/:orderId', (req, res) => {
    const order = orderManager.getOrder(req.params.orderId);
    if (order) {
        res.json({
            success: true,
            order: {
                ...order,
                isExpired: Date.now() > order.expiryTime,
                remainingTime: Math.max(0, order.expiryTime - Date.now()),
                remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
            }
        });
    } else {
        res.json({ success: false, message: '訂單不存在' });
    }
});

app.post('/api/order/:orderId/renew', (req, res) => {
    const renewedOrder = orderManager.renewOrder(req.params.orderId);
    if (renewedOrder) {
        res.json({ success: true, order: renewedOrder });
    } else {
        res.json({ success: false, message: '續約失敗' });
    }
});

app.delete('/api/order/:orderId', (req, res) => {
    const deleted = orderManager.deleteOrder(req.params.orderId);
    if (deleted) {
        res.json({ success: true, message: '訂單已刪除' });
    } else {
        res.json({ success: false, message: '刪除失敗' });
    }
});

app.get('/api/stats', (req, res) => {
    const stats = orderManager.getStatistics();
    res.json(stats);
});

// 定時任務
setInterval(async () => {
    try {
        const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
        
        for (const order of ordersNeedingReminder) {
            const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
            
            await client.pushMessage({
                to: order.userId,
                messages: [{
                    type: 'text',
                    text: `⏰ 付款提醒\n\n您有一筆待付款訂單:\n訂單編號: ${order.orderId}\n金額: NT$ ${order.amount}\n剩餘時間: ${remainingHours} 小時\n\n請盡快完成付款 🙏`
                }]
            });

            orderManager.markReminderSent(order.orderId);
            logger.logToFile(`📧 已發送付款提醒 - 訂單: ${order.orderId}`);
        }
    } catch (error) {
        logger.logError('付款提醒失敗', error);
    }
}, 60 * 60 * 1000);

setInterval(() => {
    const cleaned = orderManager.cleanExpiredOrders();
    if (cleaned > 0) {
        logger.logToFile(`🧹 自動清理了 ${cleaned} 筆過期訂單`);
    }
}, 24 * 60 * 60 * 1000);

// 啟動伺服器
app.listen(PORT, async () => {
    console.log(`伺服器正在運行,端口:${PORT}`);
    logger.logToFile(`伺服器正在運行,端口:${PORT}`);
    try {
        await customerDB.loadAllCustomers();
        console.log('✅ 客戶資料載入完成');
    } catch (error) {
        console.error('❌ 客戶資料載入失敗:', error.message);
    }

    setInterval(() => {
        const stats = orderManager.getStatistics();
        logger.logToFile(`📊 系統狀態 - 總訂單: ${stats.total}, 待付款: ${stats.pending}, 已付款: ${stats.paid}, 已過期: ${stats.expired}`);
    }, 60 * 60 * 1000);

    logger.logToFile('✅ 系統啟動完成');
});
