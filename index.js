// ============== 引入依賴 ==============
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

// 設定 multer 使用記憶體儲存
const upload = multer({ storage: multer.memoryStorage() });

// 初始化 sheet.json (如果有 GOOGLE_PRIVATE_KEY 環境變數的話)
if (process.env.GOOGLE_PRIVATE_KEY) {
    console.log(`正在初始化 sheet.json: 成功`);
    fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
    console.log(`sheet.json 初始化结束`);
} else {
    console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

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

// ============== 用戶資料儲存 ==============
const userProfiles = new Map(); // 儲存 userId -> { displayName, pictureUrl, lastSeen }

// 自動記錄用戶資料函數
async function saveUserProfile(userId) {
    try {
        if (!userProfiles.has(userId)) {
            const profile = await client.getProfile(userId);
            userProfiles.set(userId, {
                userId: userId,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl,
                statusMessage: profile.statusMessage,
                lastSeen: new Date().toISOString()
            });
            logger.logToFile(`✅ 已記錄新用戶: ${profile.displayName} (${userId})`);
        } else {
            // 更新最後活動時間
            const user = userProfiles.get(userId);
            user.lastSeen = new Date().toISOString();
            userProfiles.set(userId, user);
        }
    } catch (error) {
        logger.logError('記錄用戶資料失敗', error, userId);
    }
}

// 查詢用戶資料 API
app.get('/api/users', (req, res) => {
    const users = Array.from(userProfiles.values());
    res.json({
        total: users.length,
        users: users
    });
});

// 查詢特定用戶 API
app.get('/api/user/:userId', (req, res) => {
    const user = userProfiles.get(req.params.userId);
    if (user) {
        res.json(user);
    } else {
        res.status(404).json({ error: '找不到此用戶' });
    }
});
// ============== 新增:更新用戶名稱 API ==============
app.put('/api/user/:userId/name', express.json(), (req, res) => {
    const { userId } = req.params;
    const { displayName } = req.body;
    
    if (!displayName || displayName.trim() === '') {
        return res.status(400).json({ error: '名稱不能為空' });
    }
    
    const user = userProfiles.get(userId);
    if (user) {
        user.displayName = displayName.trim();
        user.customName = true; // 標記為自訂名稱
        userProfiles.set(userId, user);
        
        logger.logToFile(`✅ 已更新用戶名稱: ${userId} -> ${displayName}`);
        
        res.json({ 
            success: true, 
            message: '名稱已更新',
            user: user
        });
    } else {
        res.status(404).json({ error: '找不到此用戶' });
    }
});

// ============== 新增:用名稱搜尋用戶 API ==============
app.get('/api/search/user', (req, res) => {
    const { name } = req.query;
    
    if (!name) {
        return res.status(400).json({ error: '請提供搜尋名稱' });
    }
    
    const searchTerm = name.toLowerCase().trim();
    const users = Array.from(userProfiles.values());
    
    const results = users.filter(user => 
        user.displayName.toLowerCase().includes(searchTerm)
    );
    
    res.json({
        total: results.length,
        users: results
    });
});

// ============== 新增:批量匯入/匯出用戶名稱對照表 API ==============
app.post('/api/users/import', express.json(), (req, res) => {
    const { mappings } = req.body; // [{ userId, realName }]
    
    if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: '格式錯誤' });
    }
    
    let updated = 0;
    let notFound = [];
    
    mappings.forEach(mapping => {
        const user = userProfiles.get(mapping.userId);
        if (user) {
            user.displayName = mapping.realName;
            user.customName = true;
            userProfiles.set(mapping.userId, user);
            updated++;
        } else {
            notFound.push(mapping.userId);
        }
    });
    
    logger.logToFile(`✅ 批量更新用戶名稱: 成功 ${updated} 筆, 失敗 ${notFound.length} 筆`);
    
    res.json({
        success: true,
        updated: updated,
        notFound: notFound
    });
});
// ============== LINE Pay 設定 ==============
const LINE_PAY_CONFIG = {
    channelId: process.env.LINE_PAY_CHANNEL_ID,
    channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
    env: process.env.LINE_PAY_ENV || 'production',
    apiUrl: process.env.LINE_PAY_ENV === 'sandbox' 
        ? 'https://sandbox-api-pay.line.me' 
        : 'https://api-pay.line.me'
};

// LINE Pay 簽名生成函數
function generateLinePaySignature(uri, body, nonce) {
    const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
    return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
        .update(message)
        .digest('base64');
}

// ============== LINE Pay 付款請求函數 ==============
async function createLinePayPayment(userId, userName, amount) {
    try {
        const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const nonce = crypto.randomBytes(16).toString('base64');
        
        const baseURL = process.env.RAILWAY_STATIC_URL || 'https://stain-bot-production-2593.up.railway.app';
        
        const requestBody = {
            amount: amount,
            currency: 'TWD',
            orderId: orderId,
            packages: [{
                id: orderId,
                amount: amount,
                name: 'C.H精緻洗衣服務',
                products: [{
                    name: '洗衣服務費用',
                    quantity: 1,
                    price: amount
                }]
            }],
            redirectUrls: {
                confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
                cancelUrl: `${baseURL}/payment/linepay/cancel`
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
                
                // ✅ 自動記錄用戶資料
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
                    // 貼圖也會記錄用戶
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

// ============== Google OAuth 路由 ==============
app.get('/auth', (req, res) => {
    try {
        const authUrl = googleAuth.getAuthUrl();
        console.log('生成授權 URL:', authUrl);
        res.redirect(authUrl);
    } catch (error) {
        logger.logError('生成授權 URL 失敗', error);
        res.status(500).send('授權失敗: ' + error.message);
    }
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).send('缺少授權碼');
    }
    
    try {
        await googleAuth.getTokenFromCode(code);
        logger.logToFile('✅ Google OAuth 授權成功');
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>授權成功</title>
    <style>
        body { 
            font-family: sans-serif; 
            text-align: center; 
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            margin: 0 auto;
        }
        h1 { font-size: 32px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ 授權成功!</h1>
        <p>Google Sheets 和 Drive 已成功連接</p>
        <p>您可以關閉此視窗了</p>
    </div>
</body>
</html>
        `);
    } catch (error) {
        logger.logError('處理授權碼失敗', error);
        res.status(500).send('授權失敗: ' + error.message);
    }
});

app.get('/auth/status', (req, res) => {
    const isAuthorized = googleAuth.isAuthorized();
    res.json({ 
        authorized: isAuthorized,
        message: isAuthorized ? '已授權' : '未授權'
    });
});

// ============== 測試 Google Sheets OAuth 寫入 ==============
app.get('/test-sheets', async (req, res) => {
    try {
        const { google } = require('googleapis');
        const googleAuth = require('./services/googleAuth');
        
        if (!googleAuth.isAuthorized()) {
            return res.send('❌ 尚未完成 OAuth 授權!<br><a href="/auth">點此進行授權</a>');
        }
        
        const auth = googleAuth.getOAuth2Client();
        const sheets = google.sheets({ version: 'v4', auth });
        
        const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;
        
        if (!spreadsheetId) {
            return res.send('❌ 請在 .env 中設定 GOOGLE_SHEETS_ID_CUSTOMER');
        }
        
        const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'A:E',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    timestamp,
                    'OAuth 測試客戶',
                    'test@example.com',
                    '測試地址',
                    'OAuth 2.0 寫入測試成功! ✅'
                ]]
            }
        });
        
        logger.logToFile('✅ Google Sheets OAuth 測試成功');
        
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>測試成功</title>
    <style>
        body { 
            font-family: sans-serif; 
            text-align: center; 
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 600px;
            margin: 0 auto;
        }
        h1 { font-size: 32px; margin-bottom: 20px; }
        a { color: #fff; text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Google Sheets 寫入測試成功!</h1>
        <p>已成功使用 OAuth 2.0 寫入資料到試算表</p>
        <p>寫入時間: ${timestamp}</p>
        <p><a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}" target="_blank">點此查看試算表</a></p>
        <p><a href="/">返回首頁</a></p>
    </div>
</body>
</html>
        `);
        
    } catch (error) {
        logger.logError('Google Sheets 測試失敗', error);
        res.status(500).send(`測試失敗: ${error.message}<br><a href="/auth">重新授權</a>`);
    }
});

// ============== 測試照片上傳到 Google Drive ==============
app.get('/test-upload', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>測試照片上傳</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .upload-section { background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0; }
        .upload-section h2 { color: #667eea; margin-top: 0; }
        button { background: #667eea; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
        button:hover { background: #5568d3; }
        .result { margin-top: 20px; padding: 15px; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <h1>📸 測試照片上傳到 Google Drive</h1>
    
    <div class="upload-section">
        <h2>洗前照片</h2>
        <form id="uploadFormBefore">
            <input type="file" id="imageFileBefore" accept="image/*" required><br><br>
            <button type="submit">上傳洗前照片</button>
        </form>
        <div id="resultBefore" class="result"></div>
    </div>

    <script>
        document.getElementById('uploadFormBefore').addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('imageFileBefore');
            const resultDiv = document.getElementById('resultBefore');
            
            if (!fileInput.files[0]) {
                resultDiv.innerHTML = '<div class="error">請選擇照片!</div>';
                return;
            }
            
            resultDiv.innerHTML = '<div>⏳ 上傳中...</div>';
            
            const formData = new FormData();
            formData.append('image', fileInput.files[0]);
            formData.append('type', 'before');
            
            try {
                const response = await fetch('/api/test-upload-image', {
                    method: 'POST',
                    body: formData
                });
                
                const data = await response.json();
                
                if (data.success) {
                    resultDiv.innerHTML = \`<div class="success"><h3>✅ 上傳成功!</h3><p><a href="\${data.viewLink}" target="_blank">查看照片</a></p></div>\`;
                    fileInput.value = '';
                } else {
                    resultDiv.innerHTML = \`<div class="error">❌ 上傳失敗: \${data.error}</div>\`;
                }
            } catch (error) {
                resultDiv.innerHTML = \`<div class="error">❌ 錯誤: \${error.message}</div>\`;
            }
        });
    </script>
</body>
</html>
    `);
});

app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: '沒有收到圖片' });
        }
        
        const type = req.body.type || 'before';
        const { customerLogService } = require('./services/multiSheets');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const typeLabel = type === 'after' ? '洗後' : '洗前';
        const filename = `${typeLabel}_test_${timestamp}.jpg`;
        
        const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
        
        if (result.success) {
            logger.logToFile(`✅ ${typeLabel}測試上傳成功: ${filename}`);
            res.json({
                success: true,
                fileId: result.fileId,
                viewLink: result.viewLink,
                downloadLink: result.downloadLink
            });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.logError('測試上傳失敗', error);
        res.status(500).json({ success: false, error: error.message });
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
            text: '✅ 測試推播成功!這是一則主動訊息 🚀'
        });
        res.send("推播成功,請查看 LINE Bot 訊息");
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
    <p>請稍候,若未自動跳轉請點擊下方按鈕</p>
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
        <p>感謝您的支付,我們會盡快處理您的訂單</p>
        <p>您可以關閉此頁面了</p>
    </div>
</body>
</html>
    `);
});

// ============== LINE Pay 取消頁面 ==============
app.get('/payment/linepay/cancel', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>付款取消</title>
    <style>
        body { 
            font-family: sans-serif; 
            text-align: center; 
            padding: 50px;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
        }
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
        <h1>❌ 付款已取消</h1>
        <p>您已取消此次付款</p>
        <p>如需協助請聯繫客服</p>
    </div>
</body>
</html>
    `);
});

// ============== LINE Pay 確認付款 ==============
app.get('/payment/linepay/confirm', async (req, res) => {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    
    try {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = `/v3/payments/${transactionId}/confirm`;
        
        const requestBody = {
            amount: parseInt(amount),
            currency: 'TWD'
        };
        
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
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, {
                    type: 'text',
                    text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名:${decodeURIComponent(userName)}\n付款金額:NT$ ${parseInt(amount).toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${orderId}\n交易編號:${transactionId}\n\n狀態:✅ 付款成功`
                });
            }
            
            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: `✅ LINE Pay 付款成功\n\n感謝 ${decodeURIComponent(userName)} 的支付\n金額:NT$ ${parseInt(amount).toLocaleString()}\n訂單編號:${orderId}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙`
                });
            }
            
            logger.logToFile(`✅ LINE Pay 付款成功: ${decodeURIComponent(userName)} - ${amount}元`);
            
            res.redirect('/payment/success');
        } else {
            logger.logToFile(`❌ LINE Pay 付款確認失敗: ${result.returnCode} - ${result.returnMessage}`);
            res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>付款失敗</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 50px; }
        h1 { color: #e74c3c; }
    </style>
</head>
<body>
    <h1>❌ 付款失敗</h1>
    <p>${result.returnMessage}</p>
    <p>請聯繫客服處理</p>
</body>
</html>
            `);
        }
    } catch (error) {
        logger.logError('LINE Pay 確認付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});

// ============== 發送付款連結 API (整合綠界 + LINE Pay) ==============
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
        const type = paymentType || 'both';
        
        let message = '';
        let ecpayLink = '';
        let linepayLink = '';
        
        // 生成綠界連結
        if (type === 'ecpay' || type === 'both') {
            ecpayLink = createECPayPaymentLink(userId, userName, numAmount);
            
            try {
                const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
                const result = await response.text();
                if (result && result.startsWith('http')) {
                    ecpayLink = result;
                    logger.logToFile(`✅ 已縮短綠界付款網址: ${ecpayLink}`);
                }
            } catch (error) {
                logger.logToFile(`⚠️ 短網址生成失敗,使用原網址: ${error.message}`);
            }
        }
        
        // 生成 LINE Pay 連結
        if (type === 'linepay' || type === 'both') {
            const linePayResult = await createLinePayPayment(userId, userName, numAmount);
            if (linePayResult.success) {
                linepayLink = linePayResult
                linepayLink = linePayResult.paymentUrl;
                
                try {
                    const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayLink)}`);
                    const result = await response.text();
                    if (result && result.startsWith('http')) {
                        linepayLink = result;
                        logger.logToFile(`✅ 已縮短 LINE Pay 付款網址: ${linepayLink}`);
                    }
                } catch (error) {
                    logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址: ${error.message}`);
                }
            } else {
                logger.logToFile(`❌ LINE Pay 付款請求失敗: ${linePayResult.error}`);
            }
        }
        
        // 組合訊息
        if (type === 'both' && ecpayLink && linepayLink) {
            message = `💳 您好,${userName}\n\n您的專屬付款連結已生成\n金額:NT$ ${numAmount.toLocaleString()}\n\n請選擇付款方式:\n\n【綠界支付】信用卡/超商/ATM\n👉 ${ecpayLink}\n\n【LINE Pay】\n👉 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else if (type === 'ecpay' || (type === 'both' && ecpayLink && !linepayLink)) {
            message = `💳 您好,${userName}\n\n您的專屬付款連結已生成\n付款方式:信用卡/超商/ATM\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else if (type === 'linepay' || (type === 'both' && !ecpayLink && linepayLink)) {
            message = `💚 您好,${userName}\n\n您的專屬付款連結已生成\n付款方式:LINE Pay\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
        } else {
            return res.status(500).json({ error: '付款連結生成失敗' });
        }
        
        await client.pushMessage(userId, { type: 'text', text: message });
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
                linepayLink: linepayLink || null
            }
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
                    text: `🎉 收到綠界付款通知\n\n客戶姓名:${userName}\n付款金額:NT$ ${parseInt(TradeAmt).toLocaleString()}\n付款方式:${getPaymentTypeName(PaymentType)}\n付款時間:${PaymentDate}\n訂單編號:${MerchantTradeNo}\n\n狀態:✅ 付款成功`
                });
            }

            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額:NT$ ${parseInt(TradeAmt).toLocaleString()}\n訂單編號:${MerchantTradeNo}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙`
                });
            }

            logger.logToFile(`✅ 綠界付款成功: ${userName} - ${TradeAmt}元`);
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
        'WebATM_TAISHIN': '網路 ATM',
    };
    return types[code] || code;
}

// ============== 付款管理網頁 ==============
app.get('/payment', (req, res) => {
    res.sendFile(__dirname + '/public/payment.html');
});

app.get('/payment/status/:orderId', async (req, res) => {
    res.json({ message: '付款狀態查詢功能(待實作)', orderId: req.params.orderId });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行,端口:${PORT}`);
    logger.logToFile(`伺服器正在運行,端口:${PORT}`);
});

