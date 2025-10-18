require('dotenv').config();
const line = require('@line/bot-sdk');
const express = require('express');
const crypto = require('crypto');
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

        // LINE Pay 付款邏輯 (直接寫在這裡)
        const axios = require('axios');
        const channelId = process.env.LINE_PAY_CHANNEL_ID;
        const channelSecret = process.env.LINE_PAY_CHANNEL_SECRET;
        const requestUrl = '/v3/payments/request';
        const apiUrl = 'https://sandbox-api-pay.line.me' + requestUrl;

        const requestBody = {
            amount: order.amount,
            currency: 'TWD',
            orderId: orderId,
            packages: [{
                id: orderId,
                amount: order.amount,
                products: [{
                    name: `訂單 ${orderId}`,
                    quantity: 1,
                    price: order.amount
                }]
            }],
            redirectUrls: {
                confirmUrl: `https://stain-bot-production-2593.up.railway.app/payment/linepay/confirm?orderId=${orderId}`,
                cancelUrl: `https://stain-bot-production-2593.up.railway.app/payment?cancelled=true`
            }
        };

        const nonce = crypto.randomBytes(16).toString('base64');
        const signature = crypto
            .createHmac('SHA256', channelSecret)
            .update(channelSecret + requestUrl + JSON.stringify(requestBody) + nonce)
            .digest('base64');

        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': channelId,
                'X-LINE-Authorization-Nonce': nonce,
                'X-LINE-Authorization': signature
            }
        });

        if (response.data.returnCode === '0000') {
            const paymentUrl = response.data.info.paymentUrl.web;
            const transactionId = response.data.info.transactionId;
            
            orderManager.updatePaymentInfo(orderId, transactionId, paymentUrl);
            res.redirect(paymentUrl);
        } else {
            throw new Error('LINE Pay 建立付款失敗');
        }

    } catch (error) {
        logger.logError('LINE Pay 付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});

app.get('/payment/linepay/confirm', async (req, res) => {
    try {
        const { transactionId, orderId } = req.query;
        const order = orderManager.getOrder(orderId);

        if (!order) {
            return res.status(404).send('訂單不存在');
        }

        if (orderManager.isExpired(orderId)) {
            return res.send('訂單已過期');
        }

        const axios = require('axios');
        const confirmUrl = `https://sandbox-api-pay.line.me/v3/payments/${transactionId}/confirm`;
        const confirmBody = { amount: order.amount, currency: 'TWD' };
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
            // 標記所有相關訂單為已付款
            orderManager.updateOrderStatusByUserId(order.userId, 'paid', 'LINE Pay');
            logger.logToFile(`✅ LINE Pay 付款成功 - 訂單: ${orderId}`);

            // 通知客戶
            await client.pushMessage({
                to: order.userId,
                messages: [{
                    type: 'text',
                    text: `✅ 付款成功!\n\n訂單編號: ${orderId}\n金額: NT$ ${order.amount}\n付款方式: LINE Pay\n\n感謝您的支付!`
                }]
            });

            // 通知您 (店家)
            await client.pushMessage({
                to: process.env.OWNER_USER_ID || order.userId,
                messages: [{
                    type: 'text',
                    text: `🔔 收到新付款!\n\n客戶: ${order.userName}\n訂單編號: ${orderId}\n金額: NT$ ${order.amount}\n付款方式: LINE Pay`
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

        // 綠界付款邏輯 (直接寫在這裡)
        const MerchantID = process.env.ECPAY_MERCHANT_ID;
        const HashKey = process.env.ECPAY_HASH_KEY;
        const HashIV = process.env.ECPAY_HASH_IV;
        const TradeNo = orderId;
        const TradeDate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '/').replace(/\s/g, ' ');
        
        const params = {
            MerchantID: MerchantID,
            MerchantTradeNo: TradeNo,
            MerchantTradeDate: TradeDate,
            PaymentType: 'aio',
            TotalAmount: order.amount,
            TradeDesc: '洗衣服務付款',
            ItemName: `訂單 ${TradeNo}`,
            ReturnURL: 'https://stain-bot-production-2593.up.railway.app/payment/ecpay/callback',
            ClientBackURL: 'https://stain-bot-production-2593.up.railway.app/payment/ecpay/return',
            ChoosePayment: 'Credit',
            EncryptType: 1
        };

        const sortedKeys = Object.keys(params).sort();
        let checkValue = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
        checkValue = `HashKey=${HashKey}&${checkValue}&HashIV=${HashIV}`;
        checkValue = encodeURIComponent(checkValue).toLowerCase();
        checkValue = crypto.createHash('sha256').update(checkValue, 'utf8').digest('hex').toUpperCase();
        params.CheckMacValue = checkValue;

        const formHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>綠界付款</title>
            </head>
            <body>
                <form id="ecpayForm" method="post" action="https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5">
                    ${Object.keys(params).map(key => `<input type="hidden" name="${key}" value="${params[key]}">`).join('')}
                </form>
                <script>document.getElementById('ecpayForm').submit();</script>
            </body>
            </html>
        `;

        res.send(formHtml);

    } catch (error) {
        logger.logError('綠界付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});
app.post('/payment/ecpay/callback', async (req, res) => {
    try {
        logger.logToFile('收到綠界回調: ' + JSON.stringify(req.body));

        const { MerchantTradeNo, RtnCode } = req.body;

        if (RtnCode === '1') {
            const order = orderManager.getOrder(MerchantTradeNo);
            
            if (order) {
                // 標記所有相關訂單為已付款
                orderManager.updateOrderStatusByUserId(order.userId, 'paid', 'ECPay');
                logger.logToFile(`✅ 綠界付款成功 - 訂單: ${MerchantTradeNo}`);

                // 通知客戶
                await client.pushMessage({
                    to: order.userId,
                    messages: [{
                        type: 'text',
                        text: `✅ 付款成功!\n\n訂單編號: ${MerchantTradeNo}\n金額: NT$ ${order.amount}\n付款方式: 綠界 ECPay\n\n感謝您的支付!`
                    }]
                });

                // 通知您 (店家)
                await client.pushMessage({
                    to: process.env.OWNER_USER_ID || order.userId,
                    messages: [{
                        type: 'text',
                        text: `🔔 收到新付款!\n\n客戶: ${order.userName}\n訂單編號: ${MerchantTradeNo}\n金額: NT$ ${order.amount}\n付款方式: 綠界 ECPay`
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

// ==================== 🎉 超強客戶管理功能 ====================

// 取得所有客戶
app.get('/api/customers', (req, res) => {
    const customers = customerDB.getAllCustomers();
    res.json(customers);
});

// 🆕 按電話號碼搜尋客戶
app.get('/api/customer/search', (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.json({ success: false, message: '請提供電話號碼' });
    }
    
    const customers = customerDB.getAllCustomers();
    const found = customers.filter(c => c.phone && c.phone.includes(phone));
    
    if (found.length > 0) {
        res.json({ success: true, customers: found });
    } else {
        res.json({ success: false, message: '查無客戶資料' });
    }
});

// 🆕 取得單一客戶詳細資料 (包含歷史訂單)
app.get('/api/customer/:userId', (req, res) => {
    const { userId } = req.params;
    const customer = customerDB.getCustomer(userId);
    
    if (!customer) {
        return res.json({ success: false, message: '客戶不存在' });
    }
    
    // 取得客戶的所有訂單
    const orders = orderManager.getAllOrders().filter(o => o.userId === userId);
    const totalPaid = orders.filter(o => o.status === 'paid').reduce((sum, o) => sum + o.amount, 0);
    const pendingAmount = orders.filter(o => o.status === 'pending' && !orderManager.isExpired(o.orderId)).reduce((sum, o) => sum + o.amount, 0);
    
    res.json({
        success: true,
        customer: {
            ...customer,
            totalOrders: orders.length,
            totalPaid: totalPaid,
            pendingAmount: pendingAmount,
            orders: orders
        }
    });
});

// 🆕 更新客戶資料
app.post('/api/customer/update', async (req, res) => {
    try {
        const { userId, phone, email, address, notes } = req.body;
        
        const customer = customerDB.getCustomer(userId);
        if (!customer) {
            return res.json({ success: false, message: '客戶不存在' });
        }
        
        const updatedCustomer = {
            ...customer,
            phone: phone || customer.phone,
            email: email || customer.email,
            address: address || customer.address,
            notes: notes || customer.notes,
            lastUpdated: Date.now()
        };
        
        await customerDB.addOrUpdateCustomer(updatedCustomer);
        
        res.json({ success: true, customer: updatedCustomer });
    } catch (error) {
        logger.logError('更新客戶失敗', error);
        res.json({ success: false, message: error.message });
    }
});

// ==================== 🎉 訊息模板功能 ====================

// 訊息模板儲存檔案
const TEMPLATES_FILE = path.join(__dirname, 'data', 'messageTemplates.json');

// 確保檔案存在
function ensureTemplatesFile() {
    const dataDir = path.join(__dirname, 'data');
    if (!require('fs').existsSync(dataDir)) {
        require('fs').mkdirSync(dataDir, { recursive: true });
    }
    if (!require('fs').existsSync(TEMPLATES_FILE)) {
        const defaultTemplates = [
            { id: 1, name: '付款提醒', content: '親愛的客戶,您有一筆待付款訂單,請盡快完成付款。感謝您!' },
            { id: 2, name: '衣物已送達', content: '您好!您的衣物已送達門市,歡迎取件。營業時間:週一至週日 09:00-21:00' },
            { id: 3, name: '衣物清洗完成', content: '您的衣物已清洗完成!請於三日內取件,謝謝!' },
            { id: 4, name: '節慶優惠', content: '🎉 限時優惠!本週洗衣服務全面 8 折!歡迎預約!' },
            { id: 5, name: '感謝訊息', content: '感謝您的支持!期待再次為您服務 ❤️' }
        ];
        require('fs').writeFileSync(TEMPLATES_FILE, JSON.stringify(defaultTemplates, null, 2));
    }
}

ensureTemplatesFile();

// 🆕 取得所有訊息模板
app.get('/api/templates', (req, res) => {
    try {
        const templates = JSON.parse(require('fs').readFileSync(TEMPLATES_FILE, 'utf8'));
        res.json({ success: true, templates });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🆕 新增訊息模板
app.post('/api/template/add', (req, res) => {
    try {
        const { name, content } = req.body;
        if (!name || !content) {
            return res.json({ success: false, message: '請提供模板名稱和內容' });
        }
        
        const templates = JSON.parse(require('fs').readFileSync(TEMPLATES_FILE, 'utf8'));
        const newTemplate = {
            id: Date.now(),
            name: name,
            content: content,
            createdAt: Date.now()
        };
        
        templates.push(newTemplate);
        require('fs').writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
        
        res.json({ success: true, template: newTemplate });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🆕 刪除訊息模板
app.delete('/api/template/:id', (req, res) => {
    try {
        const { id } = req.params;
        let templates = JSON.parse(require('fs').readFileSync(TEMPLATES_FILE, 'utf8'));
        templates = templates.filter(t => t.id !== parseInt(id));
        require('fs').writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
        
        res.json({ success: true, message: '模板已刪除' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🆕 發送自訂訊息
app.post('/api/send-message', async (req, res) => {
    try {
        const { userId, message } = req.body;
        
        if (!userId || !message) {
            return res.json({ success: false, message: '請提供用戶 ID 和訊息內容' });
        }
        
        await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: message }]
        });
        
        logger.logToFile(`📤 發送自訂訊息給 ${userId}: ${message}`);
        res.json({ success: true, message: '訊息已發送' });
    } catch (error) {
        logger.logError('發送訊息失敗', error);
        res.json({ success: false, message: error.message });
    }
});

// ==================== 🎉 訂單管理 API ====================

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

// 🆕 營收統計
app.get('/api/revenue/stats', (req, res) => {
    const orders = orderManager.getAllOrders();
    const paidOrders = orders.filter(o => o.status === 'paid');
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const thisYear = new Date(today.getFullYear(), 0, 1);
    
    const todayRevenue = paidOrders.filter(o => o.paidAt >= today.getTime()).reduce((sum, o) => sum + o.amount, 0);
    const monthRevenue = paidOrders.filter(o => o.paidAt >= thisMonth.getTime()).reduce((sum, o) => sum + o.amount, 0);
    const yearRevenue = paidOrders.filter(o => o.paidAt >= thisYear.getTime()).reduce((sum, o) => sum + o.amount, 0);
    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.amount, 0);
    
    res.json({
        success: true,
        revenue: {
            today: todayRevenue,
            month: monthRevenue,
            year: yearRevenue,
            total: totalRevenue,
            paidOrdersCount: paidOrders.length
        }
    });
});

// 🆕 匯出訂單資料 (CSV)
app.get('/api/orders/export', (req, res) => {
    const orders = orderManager.getAllOrders();
    const csv = [
        ['訂單編號', '客戶名稱', '客戶ID', '金額', '狀態', '付款方式', '建立時間', '付款時間'].join(','),
        ...orders.map(o => [
            o.orderId,
            o.userName,
            o.userId,
            o.amount,
            o.status === 'paid' ? '已付款' : '待付款',
            o.paymentMethod || '-',
            new Date(o.createdAt).toLocaleString('zh-TW'),
            o.paidAt ? new Date(o.paidAt).toLocaleString('zh-TW') : '-'
        ].join(','))
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send('\uFEFF' + csv);
});
// ==================== 🎉 批量操作功能 ====================

// 🆕 批量發送訊息給所有待付款客戶
app.post('/api/broadcast/pending', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.json({ success: false, message: '請提供訊息內容' });
        }
        
        const pendingOrders = orderManager.getPendingOrders();
        const uniqueUsers = [...new Set(pendingOrders.map(o => o.userId))];
        
        let sentCount = 0;
        for (const userId of uniqueUsers) {
            try {
                await client.pushMessage({
                    to: userId,
                    messages: [{ type: 'text', text: message }]
                });
                sentCount++;
                await new Promise(resolve => setTimeout(resolve, 500)); // 避免太快
            } catch (error) {
                logger.logError(`發送給 ${userId} 失敗`, error);
            }
        }
        
        logger.logToFile(`📢 批量發送訊息完成,共發送 ${sentCount} 則`);
        res.json({ success: true, message: `已發送給 ${sentCount} 位客戶` });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🆕 批量發送訊息給所有客戶
app.post('/api/broadcast/all', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.json({ success: false, message: '請提供訊息內容' });
        }
        
        const customers = customerDB.getAllCustomers();
        let sentCount = 0;
        
        for (const customer of customers) {
            try {
                await client.pushMessage({
                    to: customer.userId,
                    messages: [{ type: 'text', text: message }]
                });
                sentCount++;
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                logger.logError(`發送給 ${customer.userId} 失敗`, error);
            }
        }
        
        logger.logToFile(`📢 群發訊息完成,共發送 ${sentCount} 則`);
        res.json({ success: true, message: `已發送給 ${sentCount} 位客戶` });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ==================== 🎉 快速操作功能 ====================

// 🆕 一鍵取消所有過期訂單
app.post('/api/orders/cleanup', (req, res) => {
    const cleaned = orderManager.cleanExpiredOrders();
    res.json({ success: true, message: `已清理 ${cleaned} 筆過期訂單` });
});

// 🆕 一鍵提醒所有待付款客戶
app.post('/api/orders/remind-all', async (req, res) => {
    try {
        const pendingOrders = orderManager.getPendingOrders();
        let remindedCount = 0;
        
        for (const order of pendingOrders) {
            const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
            
            await client.pushMessage({
                to: order.userId,
                messages: [{
                    type: 'text',
                    text: `⏰ 付款提醒\n\n您有一筆待付款訂單:\n訂單編號: ${order.orderId}\n金額: NT$ ${order.amount}\n剩餘時間: ${remainingHours} 小時\n\n請盡快完成付款 🙏`
                }]
            });
            
            orderManager.markReminderSent(order.orderId);
            remindedCount++;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        logger.logToFile(`📧 一鍵提醒完成,共提醒 ${remindedCount} 筆訂單`);
        res.json({ success: true, message: `已提醒 ${remindedCount} 位客戶` });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🆕 取得今日營收快報
app.get('/api/today-summary', (req, res) => {
    const orders = orderManager.getAllOrders();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayOrders = orders.filter(o => o.createdAt >= today.getTime());
    const todayPaid = todayOrders.filter(o => o.status === 'paid');
    const todayPending = todayOrders.filter(o => o.status === 'pending' && !orderManager.isExpired(o.orderId));
    
    const revenue = todayPaid.reduce((sum, o) => sum + o.amount, 0);
    const pendingAmount = todayPending.reduce((sum, o) => sum + o.amount, 0);
    
    res.json({
        success: true,
        summary: {
            date: today.toLocaleDateString('zh-TW'),
            totalOrders: todayOrders.length,
            paidOrders: todayPaid.length,
            pendingOrders: todayPending.length,
            revenue: revenue,
            pendingAmount: pendingAmount,
            customers: [...new Set(todayOrders.map(o => o.userName))]
        }
    });
});

// 🆕 搜尋功能 (模糊搜尋)
app.get('/api/search', (req, res) => {
    const { keyword } = req.query;
    if (!keyword) {
        return res.json({ success: false, message: '請提供搜尋關鍵字' });
    }
    
    const orders = orderManager.getAllOrders();
    const customers = customerDB.getAllCustomers();
    
    const matchedOrders = orders.filter(o => 
        o.orderId.toLowerCase().includes(keyword.toLowerCase()) ||
        o.userName.toLowerCase().includes(keyword.toLowerCase())
    );
    
    const matchedCustomers = customers.filter(c =>
        c.userName.toLowerCase().includes(keyword.toLowerCase()) ||
        (c.phone && c.phone.includes(keyword)) ||
        (c.email && c.email.toLowerCase().includes(keyword.toLowerCase()))
    );
    
    res.json({
        success: true,
        results: {
            orders: matchedOrders,
            customers: matchedCustomers
        }
    });
});

// ==================== ⏰ 定時任務 ====================

// 每小時自動提醒待付款訂單
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
}, 60 * 60 * 1000); // 每小時執行一次

// 每天自動清理過期訂單
setInterval(() => {
    const cleaned = orderManager.cleanExpiredOrders();
    if (cleaned > 0) {
        logger.logToFile(`🧹 自動清理了 ${cleaned} 筆過期訂單`);
    }
}, 24 * 60 * 60 * 1000); // 每天執行一次

// 🆕 每天早上 9:00 發送營收報表給您
setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() === 0) {
        try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            
            const orders = orderManager.getAllOrders();
            const yesterdayOrders = orders.filter(o => 
                o.createdAt >= yesterday.getTime() && 
                o.createdAt < yesterday.getTime() + 24 * 60 * 60 * 1000
            );
            
            const paidOrders = yesterdayOrders.filter(o => o.status === 'paid');
            const revenue = paidOrders.reduce((sum, o) => sum + o.amount, 0);
            
            const reportMessage = `📊 昨日營收報表\n\n` +
                `日期: ${yesterday.toLocaleDateString('zh-TW')}\n` +
                `總訂單: ${yesterdayOrders.length} 筆\n` +
                `已付款: ${paidOrders.length} 筆\n` +
                `營收: NT$ ${revenue}\n` +
                `客戶數: ${[...new Set(yesterdayOrders.map(o => o.userName))].length} 位\n\n` +
                `祝您今天生意興隆! 💰`;
            
            if (process.env.OWNER_USER_ID) {
                await client.pushMessage({
                    to: process.env.OWNER_USER_ID,
                    messages: [{ type: 'text', text: reportMessage }]
                });
                logger.logToFile('📊 已發送每日營收報表');
            }
        } catch (error) {
            logger.logError('發送營收報表失敗', error);
        }
    }
}, 60 * 1000); // 每分鐘檢查一次

// 🆕 每小時自動備份客戶資料
setInterval(() => {
    try {
        const customers = customerDB.getAllCustomers();
        const backupPath = path.join(__dirname, 'data', `customers_backup_${Date.now()}.json`);
        require('fs').writeFileSync(backupPath, JSON.stringify(customers, null, 2));
        logger.logToFile(`💾 自動備份客戶資料: ${customers.length} 位客戶`);
        
        // 只保留最近 7 天的備份
        const backupDir = path.join(__dirname, 'data');
        const files = require('fs').readdirSync(backupDir);
        const backupFiles = files.filter(f => f.startsWith('customers_backup_'));
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        
        backupFiles.forEach(file => {
            const timestamp = parseInt(file.match(/\d+/)[0]);
            if (timestamp < sevenDaysAgo) {
                require('fs').unlinkSync(path.join(backupDir, file));
            }
        });
    } catch (error) {
        logger.logError('自動備份失敗', error);
    }
}, 60 * 60 * 1000); // 每小時執行一次

// ==================== 🚀 啟動伺服器 ====================

app.listen(PORT, async () => {
    console.log(`
    ╔══════════════════════════════════════════════╗
    ║   🧺 C.H 精緻洗衣 - 智能付款系統啟動中...   ║
    ╚══════════════════════════════════════════════╝
    `);
    
    console.log(`✅ 伺服器正在運行,端口:${PORT}`);
    logger.logToFile(`✅ 伺服器正在運行,端口:${PORT}`);
    
    try {
        await customerDB.loadAllCustomers();
        console.log('✅ 客戶資料載入完成');
    } catch (error) {
        console.error('❌ 客戶資料載入失敗:', error.message);
    }

    // 啟動時統計
    const stats = orderManager.getStatistics();
    const customers = customerDB.getAllCustomers();
    
    console.log(`
    📊 系統狀態:
    ├─ 總客戶數: ${customers.length} 位
    ├─ 總訂單數: ${stats.total} 筆
    ├─ 待付款: ${stats.pending} 筆
    ├─ 已付款: ${stats.paid} 筆
    ├─ 已過期: ${stats.expired} 筆
    └─ 需提醒: ${stats.needReminder} 筆
    `);

    // 每小時記錄系統狀態
    setInterval(() => {
        const stats = orderManager.getStatistics();
        logger.logToFile(`📊 系統狀態 - 總訂單: ${stats.total}, 待付款: ${stats.pending}, 已付款: ${stats.paid}, 已過期: ${stats.expired}`);
    }, 60 * 60 * 1000);

    logger.logToFile('✅ 系統啟動完成 - 所有功能已就緒');
    
    console.log(`
    🎉 超強功能已啟用:
    ✓ 持續付款連結 (7天有效)
    ✓ 自動付款提醒 (每2天)
    ✓ 客戶資料管理
    ✓ 訊息模板系統
    ✓ 批量發送訊息
    ✓ 營收統計分析
    ✓ 訂單匯出功能
    ✓ 每日營收報表
    ✓ 自動資料備份
    ✓ 快速搜尋功能
    ✓ 一鍵批量操作
    
    💡 記得設定環境變數:
    OWNER_USER_ID=您的LINE用戶ID (接收通知)
    
    🚀 系統已準備就緒!
    `);
});

// 🆕 優雅關閉
process.on('SIGTERM', () => {
    logger.logToFile('📛 收到 SIGTERM 信號,正在優雅關閉...');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.logToFile('📛 收到 SIGINT 信號,正在優雅關閉...');
    process.exit(0);
});
