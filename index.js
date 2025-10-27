require('./bootstrap/storageBridge');
console.log('📦 RAILWAY_VOLUME_MOUNT_PATH =', process.env.RAILWAY_VOLUME_MOUNT_PATH);
const { createECPayPaymentLink } = require('./services/openai');
const customerDB = require('./services/customerDatabase');
const fs = require('fs');
const express = require('express');
require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');
const logger = require('./services/logger');
const messageHandler = require('./services/message');
const { Client } = require('@line/bot-sdk');
const googleAuth = require('./services/googleAuth');
const multer = require('multer');
const orderManager = require('./services/orderManager');
const upload = multer({ storage: multer.memoryStorage() });

if (process.env.GOOGLE_PRIVATE_KEY) {
    console.log(`正在初始化 sheet.json: 成功`);
    fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
    console.log(`sheet.json 初始化结束`);
} else {
    console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

const app = express();

// 指定 Volume 內存放可公開資料的資料夾
const FILE_ROOT = '/data/uploads';

// 確保這個資料夾存在（沒有就自動建立）
fs.mkdirSync(FILE_ROOT, { recursive: true });

// 讓網址 /files/... 能對應到 /data/uploads 裡的檔案
app.use('/files', express.static(FILE_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ✅ 新增：顯示伺服器實際對外 IP（用來設白名單）
app.get('/debug/my-ip', async (req, res) => {
  try {
    const r = await fetch('https://ifconfig.me/ip');
    const ip = (await r.text()).trim();
    logger.logToFile(`SERVER_EGRESS_IP = ${ip}`);
    res.type('text').send(ip); // 顯示伺服器出口 IP
  } catch (e) {
    logger.logError('取得伺服器對外 IP 失敗', e);
    res.status(500).send('無法取得伺服器 IP');
  }
});

const client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
});

async function saveUserProfile(userId) {
    try {
        const profile = await client.getProfile(userId);
        await customerDB.saveCustomer(userId, profile.displayName);
    } catch (error) {
        logger.logError('記錄用戶資料失敗', error, userId);
    }
}

app.get('/api/users', (req, res) => {
    const users = customerDB.getAllCustomers();
    res.json({ total: users.length, users: users });
});

app.get('/api/user/:userId', (req, res) => {
    const user = customerDB.getCustomer(req.params.userId);
    if (user) {
        res.json(user);
    } else {
        res.status(404).json({ error: '找不到此用戶' });
    }
});

app.put('/api/user/:userId/name', express.json(), async (req, res) => {
    const { userId } = req.params;
    const { displayName } = req.body;
    if (!displayName || displayName.trim() === '') {
        return res.status(400).json({ error: '名稱不能為空' });
    }
    try {
        const user = await customerDB.updateCustomerName(userId, displayName.trim());
        res.json({ success: true, message: '名稱已更新', user: user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search/user', (req, res) => {
    const { name } = req.query;
    if (!name) {
        return res.status(400).json({ error: '請提供搜尋名稱' });
    }
    const results = customerDB.searchCustomers(name);
    res.json({ total: results.length, users: results });
});

// 🔧 修正：LINE Pay 配置
const LINE_PAY_CONFIG = {
    channelId: process.env.LINE_PAY_CHANNEL_ID,
    channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
    env: process.env.LINE_PAY_ENV || 'production',
    apiUrl: process.env.LINE_PAY_ENV === 'sandbox' ? 'https://sandbox-api-pay.line.me' : 'https://api-pay.line.me'
};

// 🔧 修正：LINE Pay 簽名函數
function generateLinePaySignature(uri, body, nonce) {
    const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
    return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// 🔧 修正：LINE Pay 付款請求函數（修正登入問題）
async function createLinePayPayment(userId, userName, amount) {
    try {
        const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const nonce = crypto.randomBytes(16).toString('base64');
        
        // ✅ 修正 1：使用正確的 BASE_URL
        const baseURL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-2593.up.railway.app';
        
        // ✅ 修正 2：加入完整的請求參數，避免登入畫面
        const requestBody = {
            amount: amount,
            currency: 'TWD',
            orderId: orderId,
            packages: [{
                id: orderId,
                amount: amount,
                name: 'C.H精緻洗衣服務',
                products: [{
                    name: '洗衣清潔費用',
                    quantity: 1,
                    price: amount,
                    // ✅ 修正 3：加入商品圖片 URL（避免登入畫面）
                    imageUrl: `${baseURL}/images/laundry-icon.png`
                }]
            }],
            redirectUrls: {
                // ✅ 修正 4：使用正確的 confirmUrl
                confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
                cancelUrl: `${baseURL}/payment/linepay/cancel`
            },
            // ✅ 修正 5：加入 options 參數（關鍵：直接扣款，跳過登入）
            options: {
                payment: {
                    capture: true  // 自動扣款，不需要額外確認
                }
            }
        };
        
        const uri = '/v3/payments/request';
        const signature = generateLinePaySignature(uri, requestBody, nonce);
        
        const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
                'X-LINE-Authorization-Nonce': nonce,
                'X-LINE-Authorization': signature
            },
            body: JSON.stringify(requestBody)
        });
        
        const result = await response.json();
        
        if (result.returnCode === '0000') {
            logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
            return {
                success: true,
                paymentUrl: result.info.paymentUrl.web,
                orderId: orderId,
                transactionId: result.info.transactionId
            };
        } else {
            logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
            return {
                success: false,
                error: result.returnMessage
            };
        }
    } catch (error) {
        logger.logError('LINE Pay 付款請求錯誤', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ✅ 新增：LINE Pay 確認支付路由（解決支付錯誤問題）
app.get('/payment/linepay/confirm', async (req, res) => {
    try {
        const { transactionId, orderId, userId, userName, amount } = req.query;
        
        logger.logToFile(`📥 收到 LINE Pay 確認請求: orderId=${orderId}, transactionId=${transactionId}`);
        
        if (!transactionId) {
            logger.logToFile(`❌ 缺少 transactionId`);
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款失敗</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                        h1 { color: #e74c3c; }
                        p { color: #666; line-height: 1.6; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ 付款失敗</h1>
                        <p>缺少必要的交易資訊，請重新嘗試。</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        const nonce = crypto.randomBytes(16).toString('base64');
        const confirmBody = {
            amount: parseInt(amount),
            currency: 'TWD'
        };
        
        const uri = `/v3/payments/${transactionId}/confirm`;
        const signature = generateLinePaySignature(uri, confirmBody, nonce);
        
        // ✅ 呼叫 LINE Pay Confirm API
        const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
                'X-LINE-Authorization-Nonce': nonce,
                'X-LINE-Authorization': signature
            },
            body: JSON.stringify(confirmBody)
        });
        
        const result = await response.json();
        
        logger.logToFile(`LINE Pay Confirm 回應: ${JSON.stringify(result)}`);
        
        if (result.returnCode === '0000') {
            // ✅ 支付成功，更新訂單狀態
            const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
            logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);
            
            // ✅ 通知管理員
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, {
                    type: 'text',
                    text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${parseInt(amount).toLocaleString()}\n付款方式: LINE Pay\nLINE Pay 訂單: ${orderId}\n交易編號: ${transactionId}\n\n狀態: ✅ 付款成功`
                });
            }
            
            // ✅ 通知客戶
            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${parseInt(amount).toLocaleString()}\nLINE Pay 訂單: ${orderId}\n\n非常謝謝您\n感謝您的支持 💙`
                });
            }
            
            // ✅ 返回成功頁面
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款成功</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 20px rgba(0,0,0,0.2); max-width: 400px; margin: 0 auto; }
                        h1 { color: #27ae60; margin-bottom: 20px; }
                        .checkmark { font-size: 60px; color: #27ae60; margin-bottom: 20px; }
                        p { color: #666; line-height: 1.8; margin: 10px 0; }
                        .amount { font-size: 24px; color: #333; font-weight: bold; margin: 20px 0; }
                        .btn { display: inline-block; margin-top: 20px; padding: 12px 30px; background: #27ae60; color: white; text-decoration: none; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="checkmark">✅</div>
                        <h1>付款成功</h1>
                        <p>感謝 ${userName} 的支付</p>
                        <div class="amount">NT$ ${parseInt(amount).toLocaleString()}</div>
                        <p>訂單編號: ${orderId}</p>
                        <p>我們已收到您的付款</p>
                        <p>感謝您的支持 💙</p>
                        <a href="https://line.me/R/ti/p/@YOUR_LINE_ID" class="btn">返回 LINE 聊天</a>
                    </div>
                </body>
                </html>
            `);
        } else {
            // ❌ 支付失敗
            logger.logToFile(`❌ LINE Pay 確認失敗: ${result.returnCode} - ${result.returnMessage}`);
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款失敗</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                        h1 { color: #e74c3c; }
                        p { color: #666; line-height: 1.6; }
                        .error-code { background: #fee; padding: 10px; border-radius: 5px; margin: 20px 0; color: #c0392b; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ 付款失敗</h1>
                        <p>很抱歉，付款過程發生錯誤</p>
                        <div class="error-code">
                            錯誤代碼: ${result.returnCode}<br>
                            ${result.returnMessage}
                        </div>
                        <p>請稍後再試，或聯繫客服協助</p>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        logger.logError('LINE Pay 確認失敗', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>系統錯誤</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                    h1 { color: #e74c3c; }
                    p { color: #666; line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>❌ 系統錯誤</h1>
                    <p>處理付款時發生錯誤，請聯繫客服</p>
                </div>
            </body>
            </html>
        `);
    }
});

// ✅ 新增：LINE Pay 取消支付路由
app.get('/payment/linepay/cancel', (req, res) => {
    logger.logToFile(`⚠️ 用戶取消 LINE Pay 付款`);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>付款已取消</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                h1 { color: #f39c12; }
                p { color: #666; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>⚠️ 付款已取消</h1>
                <p>您已取消此次付款</p>
                <p>如需繼續付款，請重新點擊付款連結</p>
            </div>
        </body>
        </html>
    `);
});

// ✅ 新增：LINE Pay 持久化支付連結路由
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = orderManager.getOrder(orderId);
        
        if (!order) {
            logger.logToFile(`❌ 找不到訂單: ${orderId}`);
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>訂單不存在</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                        h1 { color: #e74c3c; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ 訂單不存在</h1>
                        <p>找不到此訂單，可能已過期或不存在</p>
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
                    <title>已完成付款</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 20px rgba(0,0,0,0.2); max-width: 400px; margin: 0 auto; }
                        h1 { color: #27ae60; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ 此訂單已完成付款</h1>
                        <p>感謝您的支持 💙</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // ✅ 如果已有 LINE Pay URL，直接重導向
        if (order.linepayPaymentUrl) {
            logger.logToFile(`♻️ 使用現有 LINE Pay URL: ${orderId}`);
            return res.redirect(order.linepayPaymentUrl);
        }
        
        // ✅ 重新生成 LINE Pay 付款連結
        const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
        
        if (linePayResult.success) {
            // 更新訂單中的 LINE Pay 資訊
            orderManager.updatePaymentInfo(orderId, {
                linepayTransactionId: linePayResult.transactionId,
                linepayPaymentUrl: linePayResult.paymentUrl
            });
            
            logger.logToFile(`✅ 重新生成 LINE Pay URL: ${orderId}`);
            res.redirect(linePayResult.paymentUrl);
        } else {
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>付款連結失效</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                        h1 { color: #e74c3c; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ 無法生成付款連結</h1>
                        <p>請聯繫客服協助</p>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (error) {
        logger.logError('LINE Pay 持久化連結錯誤', error);
        res.status(500).send('系統錯誤');
    }
});

// ✅ 新增：綠界持久化支付連結路由（保持一致性）
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = orderManager.getOrder(orderId);
        
        if (!order) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>訂單不存在</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
                        h1 { color: #e74c3c; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ 訂單不存在</h1>
                        <p>找不到此訂單，可能已過期或不存在</p>
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
                    <title>已完成付款</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 20px rgba(0,0,0,0.2); max-width: 400px; margin: 0 auto; }
                        h1 { color: #27ae60; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ 此訂單已完成付款</h1>
                        <p>感謝您的支持 💙</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        if (order.ecpayPaymentUrl) {
            return res.redirect(order.ecpayPaymentUrl);
        }
        
        // 重新生成綠界付款連結
        const ecpayResult = await createECPayPaymentLink(order.userId, order.userName, order.amount);
        
        if (ecpayResult.success) {
            orderManager.updatePaymentInfo(orderId, {
                ecpayPaymentUrl: ecpayResult.paymentUrl
            });
            res.redirect(ecpayResult.paymentUrl);
        } else {
            res.status(500).send('無法生成付款連結');
        }
    } catch (error) {
        logger.logError('綠界持久化連結錯誤', error);
        res.status(500).send('系統錯誤');
    }
});

app.post('/webhook', async (req, res) => {
    res.status(200).end();
    try {
        const events = req.body.events;
        for (const event of events) {
            try {
                if (event.type !== 'message' || !event.source.userId) continue;
                const userId = event.source.userId;
                console.log("[DEBUG] userId =", userId);
                await saveUserProfile(userId);
                let userMessage = '';
                if (event.message.type === 'text') {
                    userMessage = event.message.text.trim();
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleTextMessage(userId, userMessage, userMessage);
                } else if (event.message.type === 'image') {
                    userMessage = '上傳了一張圖片';
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleImageMessage(userId, event.message.id);
                } else if (event.message.type === 'sticker') {
                    userMessage = `發送了貼圖 (${event.message.stickerId})`;
                    logger.logUserMessage(userId, userMessage);
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

app.get('/auth', (req, res) => {
    try {
        const authUrl = googleAuth.getAuthUrl();
        res.redirect(authUrl);
    } catch (err) {
        logger.logError('獲取 Google 授權 URL 失敗', err);
        res.status(500).json({ error: '獲取授權 URL 失敗' });
    }
});

app.get('/oauth2callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) {
            return res.status(400).send('缺少授權碼');
        }
        const tokens = await googleAuth.getTokens(code);
        await googleAuth.saveTokens(tokens);
        res.send('✅ Google 授權成功！現在可以使用 Google Sheets 和 Google Drive 功能');
    } catch (err) {
        logger.logError('Google OAuth 回調失敗', err);
        res.status(500).send('授權失敗');
    }
});

app.post('/upload/before', upload.single('image'), async (req, res) => {
    try {
        const { userId, userName } = req.body;
        if (!req.file || !userId) {
            return res.status(400).json({ error: '缺少圖片或用戶資訊' });
        }
        const imageUrl = await googleAuth.uploadToGoogleDrive(req.file.buffer, req.file.originalname, 'before');
        logger.logToFile(`✅ 上傳前照片: ${userName} - ${imageUrl}`);
        res.json({ success: true, imageUrl: imageUrl });
    } catch (err) {
        logger.logError('上傳前照片失敗', err);
        res.status(500).json({ error: '上傳失敗' });
    }
});

app.post('/upload/after', upload.single('image'), async (req, res) => {
    try {
        const { userId, userName } = req.body;
        if (!req.file || !userId) {
            return res.status(400).json({ error: '缺少圖片或用戶資訊' });
        }
        const imageUrl = await googleAuth.uploadToGoogleDrive(req.file.buffer, req.file.originalname, 'after');
        logger.logToFile(`✅ 上傳後照片: ${userName} - ${imageUrl}`);
        res.json({ success: true, imageUrl: imageUrl });
    } catch (err) {
        logger.logError('上傳後照片失敗', err);
        res.status(500).json({ error: '上傳失敗' });
    }
});

app.get('/orders', (req, res) => {
    const orders = orderManager.getAllOrders();
    res.json({ 
        total: orders.length, 
        orders: orders.map(o => ({
            orderId: o.orderId,
            userId: o.userId,
            userName: o.userName,
            amount: o.amount,
            status: o.status,
            createdAt: o.createdAt,
            paidAt: o.paidAt,
            paymentMethod: o.paymentMethod
        }))
    });
});

app.get('/orders/unpaid', (req, res) => {
    const orders = orderManager.getUnpaidOrders();
    res.json({ total: orders.length, orders: orders });
});

app.get('/orders/user/:userId', (req, res) => {
    const orders = orderManager.getOrdersByUserId(req.params.userId);
    res.json({ total: orders.length, orders: orders });
});

app.post('/admin/send-payment', async (req, res) => {
    try {
        const { userId, userName, amount, type, message: userMessage } = req.body;
        
        if (!userId || !userName || !amount) {
            return res.status(400).json({ error: '缺少必要參數' });
        }
        
        const numAmount = parseInt(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ error: '金額格式錯誤' });
        }
        
        const validTypes = ['both', 'ecpay', 'linepay'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: '付款類型錯誤' });
        }
        
        let ecpayLink = null;
        let linepayLink = null;
        let ecpayOrderId = null;
        let linePayOrderId = null;
        
        // 🔧 修正：使用正確的 BASE_URL
        const baseURL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-2593.up.railway.app';
        
        if (type === 'both' || type === 'ecpay') {
            const ecpayResult = await createECPayPaymentLink(userId, userName, numAmount);
            if (ecpayResult.success) {
                ecpayOrderId = ecpayResult.orderId;
                const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
                try {
                    const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
                    const result = await response.text();
                    ecpayLink = (result && result.startsWith('http')) ? result : ecpayPersistentUrl;
                } catch (error) {
                    logger.logToFile(`⚠️ 綠界短網址生成失敗,使用原網址`);
                    ecpayLink = ecpayPersistentUrl;
                }
            }
        }
        
        if (type === 'both' || type === 'linepay') {
            const linePayResult = await createLinePayPayment(userId, userName, numAmount);
            if (linePayResult.success) {
                linePayOrderId = linePayResult.orderId;
                const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
                try {
                    const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
                    const result = await response.text();
                    linepayLink = (result && result.startsWith('http')) ? result : linepayPersistentUrl;
                } catch (error) {
                    logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址`);
                    linepayLink = linepayPersistentUrl;
                }
            }
        }
        
        if (ecpayOrderId) {
            orderManager.createOrder({
                orderId: ecpayOrderId,
                userId: userId,
                userName: userName,
                amount: numAmount,
                paymentType: 'ecpay',
                ecpayPaymentUrl: ecpayLink
            });
        }
        
        if (linePayOrderId) {
            orderManager.createOrder({
                orderId: linePayOrderId,
                userId: userId,
                userName: userName,
                amount: numAmount,
                paymentType: 'linepay',
                linepayPaymentUrl: linepayLink
            });
        }
        
        let finalMessage = '';
        
        if (type === 'both' && ecpayLink && linepayLink) {
            finalMessage = userMessage 
                ? `${userMessage}\n\n💙 付款連結如下:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙` 
                : `💙 您好,${userName}\n\n您的專屬付款連結已生成\n金額:NT$ ${numAmount.toLocaleString()}\n\n請選擇付款方式:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else if (type === 'ecpay' && ecpayLink) {
            finalMessage = userMessage 
                ? `${userMessage}\n\n💙 付款連結如下:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙` 
                : `💙 您好,${userName}\n\n您的專屬付款連結已生成\n付款方式:信用卡\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else if (type === 'linepay' && linepayLink) {
            finalMessage = userMessage 
                ? `${userMessage}\n\n💙 付款連結如下:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙` 
                : `💙 您好,${userName}\n\n您的專屬付款連結已生成\n付款方式:LINE Pay\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else {
            return res.status(500).json({ error: '付款連結生成失敗' });
        }
        
        await client.pushMessage(userId, { type: 'text', text: finalMessage });
        logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount}元 (${type})`);
        
        res.json({ 
            success: true, 
            message: '付款連結已發送', 
            data: { 
                userId, 
                userName, 
                amount: numAmount, 
                paymentType: type, 
                ecpayLink: ecpayLink || null, 
                linepayLink: linepayLink || null, 
                ecpayOrderId: ecpayOrderId || null, 
                linePayOrderId: linePayOrderId || null, 
                customMessage: userMessage 
            } 
        });
    } catch (err) {
        logger.logError('發送付款連結失敗', err);
        res.status(500).json({ error: '發送失敗', details: err.message });
    }
});

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
        
        if (RtnCode === '1') {
            const amount = parseInt(TradeAmt);
            const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
            logger.logToFile(`✅ 綠界付款成功,已標記 ${updated} 筆訂單為已付款`);
            
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, { 
                    type: 'text', 
                    text: `🎉 收到綠界付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${amount.toLocaleString()}\n付款方式: ${getPaymentTypeName(PaymentType)}\n付款時間: ${PaymentDate}\n綠界訂單: ${MerchantTradeNo}\n\n狀態: ✅ 付款成功` 
                });
            }
            
            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, { 
                    type: 'text', 
                    text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${amount.toLocaleString()}\n綠界訂單: ${MerchantTradeNo}\n\n非常謝謝您\n感謝您的支持 💙` 
                });
            }
            
            logger.logToFile(`✅ 綠界付款成功: ${userName} - ${TradeAmt}元 - 訂單: ${MerchantTradeNo}`);
        } else {
            logger.logToFile(`❌ 綠界付款異常: ${RtnMsg}`);
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
        'WebATM_TAISHIN': '網路 ATM' 
    };
    return types[code] || code;
}

app.get('/payment', (req, res) => {
    res.sendFile('payment.html', { root: './public' });
});

app.get('/payment/status/:orderId', async (req, res) => {
    res.json({ message: '付款狀態查詢功能(待實作)', orderId: req.params.orderId });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
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
        orderManager.cleanExpiredOrders(); 
    }, 24 * 60 * 60 * 1000);
    
    // 🔧 修正：自動提醒功能使用正確的 BASE_URL
    setInterval(async () => {
        const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
        
        if (ordersNeedingReminder.length === 0) {
            return;
        }
        
        logger.logToFile(`🔔 檢測到 ${ordersNeedingReminder.length} 筆訂單需要提醒`);
        
        const baseURL = process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-2593.up.railway.app';
        
        for (const order of ordersNeedingReminder) {
            try {
                const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
                
                if (linePayResult.success) {
                    const paymentData = {
                        linepayTransactionId: linePayResult.transactionId,
                        linepayPaymentUrl: linePayResult.paymentUrl
                    };
                    orderManager.updatePaymentInfo(order.orderId, paymentData);

                    const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${order.orderId}`;
                    let linepayShort = linepayPersistentUrl;
                    try {
                        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
                        const result = await response.text();
                        if (result && result.startsWith('http')) linepayShort = result;
                    } catch (error) {
                        logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址`);
                    }

                    const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${order.orderId}`;
                    let ecpayShort = ecpayPersistentUrl;
                    try {
                        const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
                        const t2 = await r2.text();
                        if (t2 && t2.startsWith('http')) ecpayShort = t2;
                    } catch {
                        logger.logToFile(`⚠️ 綠界短網址失敗，使用原網址`);
                    }

                    const reminderText =
                      `😊 溫馨付款提醒\n\n` +
                      `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
                      `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
                      `【信用卡／綠界】\n${ecpayShort}\n\n` +
                      `【LINE Pay】\n${linepayShort}\n\n` +
                      `備註：以上連結有效期間內可重複點擊付款。\n` +
                      `若已完成付款，請忽略此訊息。感謝您的支持 💙`;


                    await client.pushMessage(order.userId, {
                        type: 'text',
                        text: reminderText
                    });

                    logger.logToFile(`✅ 自動發送付款提醒：${order.orderId} (第 ${order.reminderCount + 1} 次)`);
                    orderManager.markReminderSent(order.orderId);
                } else {
                    logger.logToFile(`❌ 自動提醒失敗,無法生成付款連結: ${order.orderId}`);
                }
            } catch (error) {
                logger.logError(`自動提醒失敗: ${order.orderId}`, error);
            }
        }
    }, 2 * 60 * 1000);
});
