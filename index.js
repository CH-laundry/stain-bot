// ====== Bootstraps / 基礎設定 ======
require('./bootstrap/storageBridge');
console.log('RAILWAY_VOLUME_MOUNT_PATH =', process.env.RAILWAY_VOLUME_MOUNT_PATH);
// 強制載入 AI 模組以初始化 Google Sheets
console.log('🔧 正在載入 AI 模組...');
require('./services/claudeAI');
console.log('✅ AI 模組已載入');

const { createECPayPaymentLink } = require('./services/openai');
const customerDB = require('./services/customerDatabase');
const fs = require('fs');
const path = require('path'); // ⭐ 新增：用於客戶資料儲存
const express = require('express');
require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');
const logger = require('./services/logger');
const messageHandler = require('./services/message');
// ====== 載入 AI 模組（初始化 Google Sheets）======
console.log('🔧 正在載入 AI 客服模組...');
const claudeAI = require('./services/claudeAI');
console.log('✅ AI 客服模組已載入');
const { Client } = require('@line/bot-sdk');
const googleAuth = require('./services/googleAuth');
const multer = require('multer');
const orderManager = require('./services/orderManager');
const pickupRoutes = require('./pickupRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const urgentRoutes = require('./routes/urgentRoutes');
const manualRoutes = require('./routes/manualRoutes');
const upload = multer({ storage: multer.memoryStorage() });

// ★ 你的 LIFF ID
const YOUR_LIFF_ID = '2008313382-3Xna6abB';

// ★★★ 強制 HTTPS
function ensureHttpsBase(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return 'https://' + url.replace(/^\/+/, '');
  return url.replace(/^http:/i, 'https:');
}

if (process.env.GOOGLE_PRIVATE_KEY) {
  console.log(`正在初始化 sheet.json: 成功`);
  fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
  console.log(`sheet.json 初始化结束`);
} else {
  console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

const app = express();

// Volume 資料夾
const FILE_ROOT = '/data/uploads';
fs.mkdirSync(FILE_ROOT, { recursive: true });

// ====== Middleware ======
app.use('/files', express.static(FILE_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/debug', require('./services/debugStorage'));
app.use('/api/pickup', pickupRoutes.router);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/urgent', urgentRoutes);
app.use('/api/manual', manualRoutes);
// ⭐ 新增:載入洗衣軟體同步路由
const posSyncRouter = require('./pos-sync');
app.use('/api/pos-sync', posSyncRouter);

// ====== LINE Client ======
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

// ====== 使用者資料 API ======
app.get('/api/users', (req, res) => {
  const users = customerDB.getAllCustomers();
  res.json({ total: users.length, users: users });
});

app.get('/api/user/:userId', (req, res) => {
  const user = customerDB.getCustomer(req.params.userId);
  if (user) res.json(user);
  else res.status(404).json({ error: '找不到此用戶' });
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
  if (!name) return res.status(400).json({ error: '請提供搜尋名稱' });
  const results = customerDB.searchCustomers(name);
  res.json({ total: results.length, users: results });
});

// ⭐ 客人紀錄 API - 取得所有紀錄
app.get('/api/customer-records', (req, res) => {
  try {
    const customers = customerDB.getAllCustomers();
    
    // 計算統計資訊
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneWeekMs = 7 * oneDayMs;
    
    let todayCount = 0;
    let weekCount = 0;
    
    customers.forEach(customer => {
      if (customer.firstContact) {
        const diff = now - new Date(customer.firstContact).getTime();
        if (diff <= oneDayMs) todayCount++;
        if (diff <= oneWeekMs) weekCount++;
      }
    });
    
    res.json({
      success: true,
      total: customers.length,
      records: customers,
      statistics: {
        total: customers.length,
        today: todayCount,
        week: weekCount
      }
    });
  } catch (error) {
    console.error('取得客人紀錄失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ⭐ 客人紀錄 API - 取得單一客人詳情
app.get('/api/customer-records/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const customer = customerDB.getCustomer(userId);
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        error: '找不到此客人'
      });
    }
    
    res.json({
      success: true,
      record: customer
    });
  } catch (error) {
    console.error('取得客人詳情失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ====== LINE Pay 設定 ======
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : (process.env.LINE_PAY_API_URL || 'https://api-pay.line.me')
};

function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// ====== HTML 渲染 ======
function renderErrorPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}
h1{font-size:28px;margin-bottom:16px}
p{font-size:16px;line-height:1.6}
</style>
</head><body>
<div class="container">
  <h1>Warning: ${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

function renderLinePayPage(orderId, amount, remainingHours, paymentUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LINE Pay 付款</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:40px;background:linear-gradient(135deg,#06C755,#00B900);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:28px;max-width:480px;margin:0 auto;box-shadow:0 8px 32px rgba(0,0,0,0.2)}
h1{font-size:26px;margin-bottom:20px;font-weight:700}
.info{background:rgba(255,255,255,0.2);border-radius:12px;padding:16px;margin:20px 0;font-size:15px}
.btn{display:inline-block;width:90%;padding:18px;background:#fff;color:#06C755;text-decoration:none;border-radius:12px;font-weight:700;margin-top:20px;font-size:18px;border:none;box-shadow:0 4px 12px rgba(0,0,0,0.15)}
.btn:active{transform:scale(0.95)}
.note{font-size:13px;opacity:0.9;margin-top:16px;line-height:1.5}
.warning{background:rgba(255,200,0,0.25);padding:12px;border-radius:8px;margin:16px 0;font-size:14px;line-height:1.5}
</style>
</head><body>
<div class="container">
  <h1>LINE Pay 付款</h1>
  <div class="info">
    <div>訂單: ${orderId}</div>
    <div style="font-size:24px;font-weight:700;margin:12px 0">NT$ ${amount.toLocaleString()}</div>
    <div>有效期: ${remainingHours} 小時</div>
  </div>
  <div class="warning">Warning: 點擊按鈕後將前往 LINE Pay 完成付款，完成後系統會自動通知。</div>
  <a href="${paymentUrl}" class="btn">前往 LINE Pay 付款</a>
  <p class="note">請勿重複點擊；若已付款，稍後會收到成功通知。</p>
</div>
</body></html>`;
}

// ====== 建立 LINE Pay 交易 ======
async function createLinePayPayment(userId, userName, amount, orderIdOverride) {
  try {
     const orderId = orderIdOverride || `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    const confirmUrl = `${baseURL}/payment/linepay/confirm?parentOrderId=${encodeURIComponent(orderId)}`;
    const cancelUrl  = `${baseURL}/payment/linepay/cancel?parentOrderId=${encodeURIComponent(orderId)}`;

    logger.logToFile(`[DEBUG] 建立 LINE Pay 交易，confirmUrl=${confirmUrl}`);

    const requestBody = {
      amount: amount,
      currency: 'TWD',
      orderId: orderId,
      packages: [{
        id: orderId,
        amount: amount,
        name: 'C.H精緻洗衣服務',
        products: [{ name: '洗衣清潔費用', quantity: 1, price: amount }]
      }],
      redirectUrls: { confirmUrl, cancelUrl }
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
    logger.logToFile(`LINE Pay API: ${result.returnCode} - ${result.returnMessage}`);

    if (result.returnCode === '0000') {
      const paymentUrlApp = result.info?.paymentUrl?.app || null;
      const paymentUrlWeb = result.info?.paymentUrl?.web || null;
      const txId = result.info?.transactionId || null;
      const pickUrl = paymentUrlApp || paymentUrlWeb;

      return {
        success: true,
        paymentUrlApp,
        paymentUrlWeb,
        paymentUrl: pickUrl,
        orderId,
        transactionId: txId
      };
    } else {
      return { success: false, error: result.returnMessage || '請求失敗' };
    }
  } catch (error) {
    logger.logError('LINE Pay 請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ====== Webhook ======
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events;
    for (const event of events) {
      try {
        if (event.type !== 'message' || !event.source.userId) continue;
        const userId = event.source.userId;
        await saveUserProfile(userId);
  // ⭐ 更新客人對話紀錄
        try {
          await customerDB.updateCustomerActivity(userId, event.message);
        } catch (err) {
          logger.logError('更新客人活動失敗', err, userId);
        }
        
        // ========== 處理文字訊息 ==========
        if (event.message.type === 'text') {
          const userMessage = event.message.text.trim();
          logger.logUserMessage(userId, userMessage);
          
          // ⚠️ 按 1 直接給 messageHandler（智能汙漬分析）
          if (userMessage === '1' || userMessage === '１') {
            await messageHandler.handleTextMessage(userId, userMessage, userMessage);
            continue;
          }
          
          // ⭐ Claude AI 優先處理
let claudeReplied = false;
let aiResponse = '';
try {
  aiResponse = await claudeAI.handleTextMessage(userMessage, userId);
  if (aiResponse) {
    await client.pushMessage(userId, { type: 'text', text: aiResponse });  // ✅ 改成 aiResponse
    logger.logToFile(`[Claude AI] 已回覆: ${userId}`);
    claudeReplied = true;
  }
} catch (err) {
  logger.logError('[Claude AI] 失敗', err);
}

// ✅ 只有 Claude AI 沒回覆才執行原系統
if (!claudeReplied) {
  await messageHandler.handleTextMessage(userId, userMessage, userMessage);
}

// 🔥🔥🔥 加入收件偵測代碼（開始）🔥🔥🔥
// 🧺 收件關鍵字自動偵測
// ========================================

// 收件關鍵字列表
const pickupKeywords = [
  '會去收', '去收回', '來收', '過去收', '收衣服',
  '明天收', '今天收', '收取', '安排收件', '會過去收',
  '可以來收', '去拿', '會來收'
];

// 檢查訊息是否包含收件關鍵字
function containsPickupKeyword(message) {
  return pickupKeywords.some(keyword => message.includes(keyword));
}

// 🔍 情況 1：檢查「客人的訊息」是否包含收件關鍵字
if (containsPickupKeyword(userMessage)) {
  try {
    const profile = await client.getProfile(userId);
    const userName = profile.displayName;
    
    // 🔥 從 orderManager 取得客戶編號（正確方法）
    const allCustomers = orderManager.getAllCustomerNumbers();
    const customerData = allCustomers.find(c => c.userId === userId);
    const customerNumber = customerData ? customerData.number : '未登記';

    // 呼叫 API 記錄收件排程
    await fetch(`${process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app'}/api/pickup-schedule/auto-add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        userName: userName,
        message: userMessage,
        source: 'customer',
        customerNumber: customerNumber
      })
    });
    
    logger.logToFile(`[收件偵測] 客人要求收件: ${userName} (#${customerNumber}) - "${userMessage}"`);
  } catch (err) {
    logger.logError('[收件偵測] 客人訊息記錄失敗', err);
  }
}

// 🔍 情況 2：檢查「AI 的回覆」是否包含收件關鍵字
if (claudeReplied && aiResponse && containsPickupKeyword(aiResponse)) {
  try {
    const profile = await client.getProfile(userId);
    const userName = profile.displayName;
    
    // 🔥 從 orderManager 取得客戶編號（正確方法）
    const allCustomers = orderManager.getAllCustomerNumbers();
    const customerData = allCustomers.find(c => c.userId === userId);
    const customerNumber = customerData ? customerData.number : '未登記';

    // 呼叫 API 記錄收件排程
    await fetch(`${process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app'}/api/pickup-schedule/auto-add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        userName: userName,
        message: aiResponse,
        source: 'ai',
        customerNumber: customerNumber
      })
    });
    
    logger.logToFile(`[收件偵測] AI 承諾收件: ${userName} (#${customerNumber}) - "${aiResponse}"`);
  } catch (err) {
    logger.logError('[收件偵測] AI 訊息記錄失敗', err);
  }
}
// 🔥🔥🔥 收件偵測代碼（結束）🔥🔥🔥

}  // ⬅️ 這才是 if (event.message.type === 'text') 的結束

// ========== 處理圖片訊息 ==========
else if (event.message.type === 'image') {
  logger.logUserMessage(userId, '上傳了一張圖片');
  await messageHandler.handleImageMessage(userId, event.message.id);
} 

// ========== 處理貼圖訊息 ==========
else if (event.message.type === 'sticker') {
  logger.logUserMessage(userId, `發送了貼圖 (${event.message.stickerId})`);
} 

// ========== 其他訊息 ==========
else {
  logger.logUserMessage(userId, '發送了其他類型的訊息');
}

      } catch (err) {
        logger.logError('處理事件時出錯', err, event.source?.userId);
      }
    }
  } catch (err) {
    logger.logError('全局錯誤', err);
  }
});

// ====== Google OAuth ======
app.get('/auth', (req, res) => {
  try {
    const authUrl = googleAuth.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    logger.logError('生成授權 URL 失敗', error);
    res.status(500).send('授權失敗: ' + error.message);
  }
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('缺少擔保碼');
  try {
    await googleAuth.getTokenFromCode(code);
    logger.logToFile('Google OAuth 授權成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>授權成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}</style></head><body><div class="container"><h1>授權成功!</h1><p>Google Sheets 和 Drive 已成功連接</p><p>您可以關閉此視窗了</p></div></body></html>');
  } catch (error) {
    logger.logError('處理擔保碼失敗', error);
    res.status(500).send('授權失敗: ' + error.message);
  }
});

app.get('/auth/status', (req, res) => {
  const isAuthorized = googleAuth.isAuthorized();
  res.json({ authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

app.get('/test-sheets', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    if (!googleAuth.isAuthorized()) {
      return res.send('尚未完成 OAuth 授權!<br><a href="/auth">點此進行授權</a>');
    }
    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;
    if (!spreadsheetId) {
      return res.send('請在 .env 中設定 GOOGLE_SHEETS_ID_CUSTOMER');
    }
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:E',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[timestamp, 'OAuth 測試客戶', 'test@example.com', '測試地址', 'OAuth 2.0 寫入測試成功!']] }
    });
    logger.logToFile('Google Sheets OAuth 測試成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:600px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}a{color:#fff;text-decoration:underline}</style></head><body><div class="container"><h1>Google Sheets 寫入測試成功!</h1><p>已成功使用 OAuth 2.0 寫入資料到試算表</p><p>寫入時間: ' + timestamp + '</p><p><a href="https://docs.google.com/spreadsheets/d/' + spreadsheetId + '" target="_blank">點此查看試算表</a></p><p><a href="/">返回首頁</a></p></div></body></html>');
  } catch (error) {
    logger.logError('Google Sheets 測試失敗', error);
    res.status(500).send(`測試失敗: ${error.message}<br><a href="/auth">重新授權</a>`);
  }
});

app.get('/test-upload', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試上傳</title></head><body><h1>測試上傳功能已停用</h1></body></html>');
});

app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '沒有收到圖片' });
    const type = req.body.type || 'before';
    const { customerLogService } = require('./services/multiSheets');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const typeLabel = type === 'after' ? '洗後' : '洗前';
    const filename = `${typeLabel}_test_${timestamp}.jpg`;
    const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
    if (result.success) {
      logger.logToFile(`${typeLabel}測試上傳成功: ${filename}`);
      res.json({ success: true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

app.get('/test-push', async (req, res) => {
  const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx";
  try {
    await client.pushMessage(userId, { type: 'text', text: '測試推播成功!這是一則主動訊息' });
    res.send("推播成功,請查看 LINE Bot 訊息");
  } catch (err) {
    console.error("推播錯誤", err);
    res.status(500).send(`推播失敗: ${err.message}`);
  }
});

app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try {
    const paymentData = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const formHTML =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>跳轉到綠界付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px}.loading{font-size:18px;color:#666}</style></head><body><h3 class="loading">正在跳轉到付款頁面...</h3><p>請稍候,若未自動跳轉請點擊下方按鈕</p><form id="ecpayForm" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">' +
      Object.keys(paymentData).map(key => `<input type="hidden" name="${key}" value="${paymentData[key]}">`).join('\n') +
      '<button type="submit" style="padding:10px 20px;font-size:16px;cursor:pointer">前往付款</button></form><script>setTimeout(function(){document.getElementById("ecpayForm").submit()},500)</script></body></html>';
    res.send(formHTML);
  } catch (error) {
    logger.logError('付款跳轉失敗', error);
    res.status(500).send('付款連結錯誤');
  }
});

app.all('/payment/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>付款成功</title>
  <style>
    body {
      font-family: sans-serif;
      text-align: center;
      padding: 50px 20px;
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      color: white;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      margin: 0 auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .success-icon {
      font-size: 80px;
      margin-bottom: 20px;
      animation: scaleIn 0.5s ease-out;
    }
    @keyframes scaleIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }
    h1 {
      color: #fff;
      font-size: 48px;
      margin: 20px 0;
      font-weight: bold;
    }
    p {
      font-size: 20px;
      line-height: 1.6;
      margin: 15px 0;
    }
    .highlight {
      background: rgba(255, 255, 255, 0.25);
      padding: 20px;
      border-radius: 12px;
      margin: 25px 0;
      font-size: 18px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✅</div>
    <h1>付款成功！</h1>
    <div class="highlight">
      <p><strong>感謝您的支付</strong></p>
      <p>我們已收到您的付款</p>
    </div>
    <p style="font-size: 16px; opacity: 0.9;">
      系統會自動通知我們<br>
      您可以關閉此頁面了
    </p>
  </div>
</body>
</html>`);
});

// ====== 綠界持久付款頁 ======
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>訂單不存在</h1><p>找不到此訂單</p></div></body></html>');
  }

  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}</style></head><body><div class="container"><h1>訂單已過期</h1><p>此訂單已超過 7 天(168 小時)</p><p>已過時間: ' + Math.floor(hoursPassed) + ' 小時</p><p>訂單編號: ' + orderId + '</p><p>請聯繫 C.H 精緻洗衣客服重新取得訂單</p></div></body></html>');
  }

  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ' + orderId + '</p></div></body></html>');
  }

  try {
    logger.logToFile(`重新生成綠界付款連結: ${orderId}`);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往綠界付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head><body><div class="container"><h1>前往綠界付款</h1><div class="info"><p><strong>訂單編號:</strong> ' + orderId + '</p><p><strong>客戶姓名:</strong> ' + order.userName + '</p><p><strong>金額:</strong> NT$ ' + order.amount.toLocaleString() + '</p><p><strong>剩餘有效時間:</strong> ' + remainingHours + ' 小時</p></div><p>正在為您生成付款連結...</p><p>若未自動跳轉，請點擊下方按鈕</p><a href="' + ecpayLink + '" class="btn">立即前往綠界付款</a></div><script>setTimeout(function(){window.location.href="' + ecpayLink + '"},1500)</script></body></html>');
    logger.logToFile(`綠界付款連結已重新生成: ${orderId}`);
  } catch (error) {
    logger.logError('重新生成綠界連結失敗', error);
    res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>付款連結生成失敗</h1><p>請聯繫客服處理</p></body></html>');
  }
});

// ====== 綠界付款結果通知 (只更新為已付款，不動其他功能) ======
app.post('/payment/ecpay/notify', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const data = req.body;
    const orderId = data.MerchantTradeNo;
    const rtnCode = data.RtnCode;

    logger.logToFile(`[ECPAY][NOTIFY] 收到通知: ${JSON.stringify(data)}`);

    // ✅ 若付款成功 (rtnCode=1)
    if (rtnCode === '1' || rtnCode === 1) {
      const order = orderManager.getOrder(orderId);
      if (order && order.status !== 'paid') {
        order.status = 'paid';
        orderManager.saveOrders();
        logger.logToFile(`[ECPAY][SUCCESS] 訂單 ${orderId} 狀態更新為已付款`);
      }
    }

    // ✅ 綠界要求回傳 "1|OK" 表示接收成功
    res.send('1|OK');
  } catch (err) {
    logger.logError('ECPAY 通知處理錯誤', err);
    res.send('0|ERROR');
  }
});


// ====== LINE Pay 持久付款頁 ======
const creatingTransactions = new Set();

app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(renderErrorPage('訂單不存在', '找不到此訂單'));
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send(renderErrorPage('訂單已過期', `此訂單已超過 7 天<br>訂單編號: ${orderId}`));
  }
  if (order.status === 'paid') {
    return res.send(renderErrorPage('訂單已付款', `此訂單已完成付款<br>訂單編號: ${orderId}`));
  }

  try {
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        logger.logToFile(`重用既有連結: ${orderId}（${Math.floor(elapsed / 1000)} 秒前建立）`);
        const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
        return res.send(renderLinePayPage(orderId, order.amount, remainingHours, order.linepayPaymentUrl));
      }
    }

    if (creatingTransactions.has(orderId)) {
      logger.logToFile(`建立中: ${orderId}，等待 1 秒再查`);
      await new Promise(r => setTimeout(r, 1000));
      const fresh = orderManager.getOrder(orderId);
      if (fresh.linepayTransactionId && fresh.linepayPaymentUrl) {
        const elapsed2 = Date.now() - (fresh.lastLinePayRequestAt || 0);
        if (elapsed2 < 15 * 60 * 1000) {
          logger.logToFile(`使用剛建立的連結: ${orderId}`);
          const remainingHours = Math.floor((fresh.expiryTime - Date.now()) / (1000 * 60 * 60));
          return res.send(renderLinePayPage(orderId, fresh.amount, remainingHours, fresh.linepayPaymentUrl));
        }
      }
      return res.status(503).send(renderErrorPage('付款連結建立中', '正在為您建立付款連結<br>請稍候 2 秒後重新整理'));
    }

    creatingTransactions.add(orderId);
    try {
      logger.logToFile(`建立新 LINE Pay 交易: ${orderId}`);
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount, orderId);
      if (!lp.success) {
        return res.status(500).send(renderErrorPage('生成失敗', lp.error || '無法建立付款連結'));
      }

      const urlApp = lp.paymentUrlApp || null;
      const urlWeb = lp.paymentUrlWeb || null;
      const urlAny = urlApp || urlWeb || lp.paymentUrl;

      orderManager.updatePaymentInfo(orderId, {
        linepayTransactionId: lp.transactionId,
        linepayPaymentUrl: urlAny,
        linepayPaymentUrlApp: urlApp,
        linepayPaymentUrlWeb: urlWeb,
        lastLinePayRequestAt: Date.now()
});

const ua = String(req.headers['user-agent'] || '');
const preferApp = /Line\/|LineApp/i.test(ua); // 判斷是否在 LINE App 內
const chosenUrl = preferApp ? (urlApp || urlAny) : (urlWeb || urlAny);

const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
return res.send(renderLinePayPage(orderId, order.amount, remainingHours, chosenUrl));

    } finally {
      creatingTransactions.delete(orderId);
    }
  } catch (error) {
    creatingTransactions.delete(orderId);
    logger.logError('LINE Pay 付款頁面錯誤', error);
    return res.status(500).send(renderErrorPage('系統錯誤', '請稍後重試或聯繫客服'));
  }
});

/* ========= LINE Pay 背景確認處理 ========= */
async function handleLinePayConfirm(transactionId, orderId, parentOrderId) {
  logger.logToFile(`[LINEPAY][CONFIRM] 開始處理：tx=${transactionId} parent=${parentOrderId} order=${orderId}`);

  let order = null;
  if (parentOrderId) order = orderManager.getOrder(parentOrderId);
  if (!order && transactionId) {
    const all = orderManager.getAllOrders();
    for (const o of Object.values(all)) {
      if (o.linepayTransactionId === transactionId && o.status === 'pending') {
        order = o;
        break;
      }
    }
  }
  if (!order && orderId) order = orderManager.getOrder(orderId);
  if (!order) {
    logger.logToFile(`[LINEPAY][CONFIRM] 訂單不存在`);
    return;
  }

  if (orderManager.isExpired(order.orderId) || order.status === 'paid') {
    logger.logToFile(`[LINEPAY][CONFIRM] 訂單已過期或已付款`);
    return;
  }

  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: order.amount, currency: 'TWD' };
    const signature = generateLinePaySignature(uri, body, nonce);

    const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    if (result.returnCode === '0000') {
      orderManager.updateOrderStatus(order.orderId, 'paid', 'LINE Pay');
      logger.logToFile(`[LINEPAY][SUCCESS] ${order.orderId} 付款成功`);

    // 🔥🔥🔥 【請貼在這裡：LINE Pay 成功後加入同步清單】 🔥🔥🔥
    if (global.pendingSyncOrders) {
         global.pendingSyncOrders.push({
              orderId: order.orderId,  // ⚠️ 請確認這裡的 orderId 是對應到洗衣店的單號 (例如 001005680)
              amount: order.amount,
              payType: 'LINE'
          });
          console.log(`[Payment] LINE Pay 訂單 ${order.orderId} 已加入同步佇列`);
      }
      // 🔥🔥🔥 【結束】 🔥🔥🔥
      
      if (process.env.ADMIN_USER_ID) {
        client.pushMessage(process.env.ADMIN_USER_ID, {
          type: 'text',
          text: `收到 LINE Pay 付款通知\n\n客戶姓名:${order.userName}\n付款金額:NT$ ${order.amount.toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${order.orderId}\n交易編號:${transactionId}\n\n狀態:付款成功`
        }).catch(() => {});
      }

      if (order.userId && order.userId !== 'undefined') {
        client.pushMessage(order.userId, {
          type: 'text',
          text: `✅ LINE Pay 付款成功\n\n感謝 ${order.userName} 的支付\n金額:NT$ ${order.amount.toLocaleString()}\n訂單編號:${order.orderId}\n\n非常謝謝您\n感謝您的支持 💙`
        }).catch(() => {});
      }
    } else {
      logger.logToFile(`[LINEPAY][FAIL] Confirm 失敗: ${result.returnCode} - ${result.returnMessage}`);
    }
  } catch (error) {
    logger.logError('Confirm 處理失敗', error);
  }
}

// ====== 綠界 ReturnURL（伺服器背景通知）======
// 支援 POST / GET；為避免綠界重試，先回 "1|OK"（若你想嚴謹驗章後再回，也可移到成功分支最後）
function generateECPayCheckMacValue(params) {
  const { ECPAY_HASH_KEY, ECPAY_HASH_IV } = process.env;
  const data = { ...params };
  delete data.CheckMacValue;

  const sortedKeys = Object.keys(data).sort();
  let raw = `HashKey=${ECPAY_HASH_KEY}`;
  sortedKeys.forEach((k) => { raw += `&${k}=${data[k]}`; });
  raw += `&HashIV=${ECPAY_HASH_IV}`;

  raw = encodeURIComponent(raw)
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .toLowerCase();

  return require('crypto')
    .createHash('sha256')
    .update(raw)
    .digest('hex')
    .toUpperCase();
}

// ====== 綠界 ReturnURL (伺服器背景通知) [已修復] ======
app.all('/payment/ecpay/callback', async (req, res) => {
  try {
    // 1) 先回覆綠界，避免重試
    res.type('text').send('1|OK');

    // 2) 取得回傳資料
    const data = { ...req.body, ...req.query };

    // 3) 驗證 CheckMacValue
    const mac = String(data.CheckMacValue || '');
    const calc = generateECPayCheckMacValue(data);
    if (!mac || mac.toUpperCase() !== calc.toUpperCase()) {
      logger.logToFile('[ECPAY][WARN] CheckMacValue 不一致');
      return; 
    }

    // 4) 僅在成功時處理
    if (String(data.RtnCode) !== '1') {
      logger.logToFile(`[ECPAY][INFO] 非成功回傳：RtnCode=${data.RtnCode}`);
      return;
    }

    // ✅【更新訂單狀態】
    const allOrders = orderManager.getAllOrders();
    for (const order of allOrders) {
      const oid = order.orderId;
      if (
        order.userId === data.CustomField1 &&
        Number(order.amount) === Number(data.TradeAmt || data.Amount || 0) &&
        order.status !== 'paid'
      ) {
        orderManager.updateOrderStatus(oid, 'paid', 'ECPay');
        logger.logToFile(`[ECPAY][UPDATE] 訂單 ${oid} 狀態更新為已付款`);

        // 🔥 通知店裡電腦 (同步清單)
        if (global.pendingSyncOrders) {
            global.pendingSyncOrders.push({
                orderId: oid,
                amount: Number(order.amount),
                payType: 'CREDIT' 
            });
            console.log(`[Payment] 綠界訂單 ${oid} 已加入同步佇列`);
        }
        break; 
      }
    }

    // 5) 記錄日誌與通知
    const merchantTradeNo = data.MerchantTradeNo;
    const amount = Number(data.TradeAmt || data.Amount || 0);
    const payType = data.PaymentType || 'ECPay';
    const userId = data.CustomField1 || '';   
    const userName = data.CustomField2 || ''; 

    logger.logToFile(`[ECPAY][SUCCESS] ${merchantTradeNo} 成功 NT$${amount}`);

    if (process.env.ADMIN_USER_ID) {
      client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: `✅ 綠界付款成功\n客戶：${userName}\n金額：NT$ ${amount}`
      }).catch(() => {});
    }

    if (userId && userId !== 'undefined') {
      client.pushMessage(userId, {
        type: 'text',
        text: `✅ 付款成功（綠界）\n感謝您的支持 💙`
      }).catch(() => {});
    }
  } catch (err) {
    logger.logError('[ECPAY][ERROR] 回調處理失敗', err);
  }
});

// ====== Line Pay Confirm (付款確認頁面) [已修復] ======
app.all('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, parentOrderId } = { ...req.query, ...req.body };
  
  // 顯示成功頁面
  res.status(200).send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>付款成功</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 50px 20px; background: #06C755; color: white; }
    h1 { font-size: 32px; font-weight: bold; }
  </style>
</head>
<body>
  <h1>✅ 付款成功！</h1>
  <p>LINE Pay 付款已完成，感謝您的支持。</p>
</body>
</html>
  `);

  // 背景處理確認
  setImmediate(() => {
    handleLinePayConfirm(transactionId, orderId, parentOrderId).catch(() => {});
  });
});
// 🔥 在這裡加入手動觸發 API（開始）🔥
app.get('/api/generate-weekly-report', async (req, res) => {
  try {
    console.log('🔍 手動觸發週報生成...');
    
    const weeklyAnalysis = require('./services/weeklyAnalysis');
    const reportGenerator = require('./services/reportGenerator');
    
    // 1. 分析數據
    const analysis = await weeklyAnalysis.analyzeWeeklyData();
    
    if (!analysis || analysis.error) {
      return res.status(500).json({
        success: false,
        error: analysis?.error || '分析失敗'
      });
    }

    // 2. 生成優化建議
    const suggestions = await reportGenerator.generateSuggestions(analysis);
    
    // 3. 格式化報告
    const report = reportGenerator.formatReport(analysis, suggestions);
    
    // 4. 發送到 LINE
    if (process.env.ADMIN_USER_ID) {
      await client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: report
      });
    }
    
    res.json({
      success: true,
      message: '週報已生成並發送到 LINE',
      preview: report.substring(0, 200) + '...'
    });
    
  } catch (error) {
    console.error('手動週報生成失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// 🔥 手動觸發 API（結束）🔥
// ====== 其餘 API 保持不變（以下全部保留） ======
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  let orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const ordersWithStatus = orders.map(order => ({
    ...order,
    isExpired: orderManager.isExpired(order.orderId),
    remainingTime: Math.max(0, order.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  res.json({
    success: true,
    total: ordersWithStatus.length,
    orders: ordersWithStatus,
    statistics: orderManager.getStatistics()
  });
});

app.get('/api/order/:orderId', (req, res) => {
  const order = orderManager.getOrder(req.params.orderId);
  if (order) {
    res.json({
      success: true,
      order: {
        ...order,
        isExpired: orderManager.isExpired(order.orderId),
        remainingTime: Math.max(0, order.expiryTime - Date.now()),
        remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
      }
    });
  } else {
    res.status(404).json({ success: false, error: '找不到此訂單' });
  }
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    let ecpayShort = ecpayPersistentUrl;
    let linepayShort = linepayPersistentUrl;

    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayShort = t2;
    } catch { logger.logToFile(`綠界短網址失敗，使用原網址`); }

    try {
      const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
      const t1 = await r1.text();
      if (t1 && t1.startsWith('http')) linepayShort = t1;
    } catch { logger.logToFile(`LINE Pay 短網址失敗,使用原網址`); }

    await client.pushMessage(order.userId, {
      type: 'text',
      text:
        `付款連結已重新生成（持久網址）\n\n` +
        `訂單編號: ${orderId}\n客戶姓名: ${order.userName}\n金額: NT$ ${order.amount.toLocaleString()}\n\n` +
        `— 請選擇付款方式 —\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結可重複點擊，隨時都可以付款。\n` +
        `付款後系統會自動通知我們`
    });

    orderManager.markReminderSent(orderId);
    logger.logToFile(`單筆續約重發（綠界+LINE Pay 持久網址）：${orderId}`);

    return res.json({
      success: true,
      message: '訂單已續約並重新發送付款連結（持久網址：綠界 + LINE Pay）',
      order,
      links: { ecpay: ecpayShort, linepay: linepayShort }
    });
  } catch (error) {
    logger.logError('續約訂單失敗', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const deleted = orderManager.deleteOrder(req.params.orderId);
  if (deleted) res.json({ success: true, message: '訂單已刪除' });
  else res.status(404).json({ success: false, error: '找不到此訂單' });
});

app.post('/api/orders/send-reminders', async (req, res) => {
  const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
  if (ordersNeedingReminder.length === 0) {
    return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });
  }

  let sent = 0;
  const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
  const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

  for (const order of ordersNeedingReminder) {
    try {
      const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${order.orderId}`;
      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${order.orderId}`;

      let linepayShort = linepayPersistentUrl;
      let ecpayShort = ecpayPersistentUrl;

      try {
        const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
        const t1 = await r1.text();
        if (t1 && t1.startsWith('http')) linepayShort = t1;
      } catch {}

      try {
        const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const t2 = await r2.text();
        if (t2 && t2.startsWith('http')) ecpayShort = t2;
      } catch {}

      const reminderText =
        `溫馨付款提醒\n\n` +
        `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
        `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結有效期間內可重複點擊付款。\n` +
        `若已完成付款，請忽略此訊息。感謝您的支持 💙`;

      await client.pushMessage(order.userId, { type: 'text', text: reminderText });

      sent++;
      orderManager.markReminderSent(order.orderId);
      logger.logToFile(`已發送付款提醒：${order.orderId} (第 ${order.reminderCount} 次)`);
    } catch (error) {
      logger.logError(`發送提醒失敗: ${order.orderId}`, error);
    }
  }

  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent: sent });
});

app.get('/api/orders/statistics', (req, res) => {
  res.json({ success: true, statistics: orderManager.getStatistics() });
});

app.get('/api/customer-numbers', (req, res) => {
  try {
    const customers = orderManager.getAllCustomerNumbers();
    res.json({ success: true, total: customers.length, customers });
  } catch (error) {
    console.error('API /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/customer-numbers', (req, res) => {
  try {
    const { number, name, userId } = req.body;
    if (!number || !name || !userId) {
      return res.status(400).json({ success: false, error: '請填寫所有欄位' });
    }
    const customer = orderManager.saveCustomerNumber(number, name, userId);
    res.json({ success: true, message: '客戶編號已儲存', customer });
  } catch (error) {
    console.error('API POST /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/customer-numbers/:number', (req, res) => {
  try {
    const deleted = orderManager.deleteCustomerNumber(req.params.number);
    if (deleted) {
      res.json({ success: true, message: '客戶編號已刪除' });
    } else {
      res.status(404).json({ success: false, error: '找不到此客戶編號' });
    }
  } catch (error) {
    console.error('API DELETE /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/customer-numbers/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: '請提供搜尋關鍵字' });
    const results = orderManager.searchCustomerNumber(q);
    res.json({ success: true, total: results.length, customers: results });
  } catch (error) {
    console.error('API /api/customer-numbers/search 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/templates', (req, res) => {
  try {
    const templates = orderManager.getAllTemplates();
    res.json({ success: true, total: templates.length, templates });
  } catch (error) {
    console.error('API /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    orderManager.addTemplate(content.trim());
    res.json({ success: true, message: '模板已新增' });
  } catch (error) {
    console.error('API POST /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    const success = orderManager.updateTemplate(index, content.trim());
    if (success) res.json({ success: true, message: '模板已更新' });
    else res.status(404).json({ success: false, error: '找不到此模板' });
  } catch (error) {
    console.error('API PUT /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const success = orderManager.deleteTemplate(index);
    if (success) res.json({ success: true, message: '模板已刪除' });
    else res.status(404).json({ success: false, error: '找不到此模板' });
  } catch (error) {
    console.error('API DELETE /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== 純文字通知模板管理 ======
const NOTIFY_TEMPLATES_FILE = '/data/notify-templates.json';

function loadNotifyTemplates() {
  try {
    if (fs.existsSync(NOTIFY_TEMPLATES_FILE)) {
      const data = fs.readFileSync(NOTIFY_TEMPLATES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.logError('載入通知模板失敗', error);
  }
  return [];
}

function saveNotifyTemplatesFile(templates) {
  try {
    fs.writeFileSync(NOTIFY_TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger.logError('儲存通知模板失敗', error);
    return false;
  }
}

app.get('/api/notify-templates', (req, res) => {
  try {
    const templates = loadNotifyTemplates();
    res.json({ success: true, templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/notify-templates', (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    
    const templates = loadNotifyTemplates();
    templates.push(content.trim());
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已儲存' });
    } else {
      res.status(500).json({ success: false, error: '儲存失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/notify-templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    
    const templates = loadNotifyTemplates();
    if (index < 0 || index >= templates.length) {
      return res.status(404).json({ success: false, error: '找不到此模板' });
    }
    
    templates[index] = content.trim();
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已更新' });
    } else {
      res.status(500).json({ success: false, error: '更新失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/notify-templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const templates = loadNotifyTemplates();
    
    if (index < 0 || index >= templates.length) {
      return res.status(404).json({ success: false, error: '找不到此模板' });
    }
    
    templates.splice(index, 1);
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已刪除' });
    } else {
      res.status(500).json({ success: false, error: '刪除失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const deliveryService = require('./services/deliveryService');
deliveryService.setLineClient(client);

// ========================================
// ========================================
// API 1: 金額=0的簡單通知
// ========================================
app.post('/api/delivery/mark-signed-simple', async (req, res) => {
  try {
    const { id, customerNumber, customerName } = req.body;

    if (!id || !customerNumber || !customerName) {
      return res.json({
        success: false,
        error: '缺少必要參數'
      });
    }

    // ✅ 更新外送紀錄為已簽收
    const deliveryRoutes = require('./routes/deliveryRoutes');
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    const order = data.orders.find(o => o.id === id);
    
    if (order) {
      order.signed = true;
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    }

    await deliveryService.markSignedSimple(id, customerNumber, customerName);

    res.json({ success: true });

  } catch (error) {
    console.error('API Error:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// API 2: 金額>0發送支付連結
// ========================================
app.post('/api/delivery/mark-signed-with-payment', async (req, res) => {
  try {
    const { id, customerNumber, customerName, amount } = req.body;

    if (!id || !customerNumber || !customerName || !amount) {
      return res.json({
        success: false,
        error: '缺少必要參數'
      });
    }

    // ✅ 更新外送紀錄為已簽收
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    const order = data.orders.find(o => o.id === id);
    
    if (order) {
      order.signed = true;
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    }

    const result = await deliveryService.markSignedWithPayment(
      id,
      customerNumber,
      customerName,
      amount
    );

    res.json({
      success: true,
      orderId: result.orderId
    });

  } catch (error) {
    console.error('API Error:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ====== 發送純文字通知 ======
app.post('/send-notification', async (req, res) => {
  const { userId, userName, message } = req.body;
  
  logger.logToFile(`收到純文字通知請求: userId=${userId}, userName=${userName}`);

  if (!userId || !userName || !message) {
    logger.logToFile(`參數驗證失敗`);
    return res.status(400).json({ 
      success: false, 
      error: '缺少必要參數', 
      required: ['userId', 'userName', 'message'] 
    });
  }

  try {
    await client.pushMessage(userId, { 
      type: 'text', 
      text: message 
    });
    
    logger.logToFile(`已發送純文字通知給: ${userName} (${userId})`);

    res.json({
      success: true,
      message: '通知已發送',
      data: {
        userId,
        userName,
        messageLength: message.length
      }
    });
  } catch (err) {
    logger.logError('發送純文字通知失敗', err);
    res.status(500).json({ 
      success: false, 
      error: '發送失敗', 
      details: err.message 
    });
  }
});
// ====== 修改後的發送付款 API (整合 #指定單號 + 自動存客戶資料) ======
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  
  // 1. 記錄請求
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);

  if (!userId || !userName || !amount) {
    logger.logToFile(`參數驗證失敗`);
    return res.status(400).json({ error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }

  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: '金額必須是正整數' });
  }

  // 🔥🔥🔥 【魔術代碼功能】 🔥🔥🔥
  // 檢查訊息內容是否有 #單號
  let manualOrderId = null;
  if (customMessage && customMessage.includes('#')) {
      const match = customMessage.match(/#([a-zA-Z0-9]+)/);
      if (match) {
          manualOrderId = match[1]; // 抓出 # 後面的號碼
          logger.logToFile(`🎯 偵測到指定單號: ${manualOrderId}`);
      }
  }
  // 🔥🔥🔥 結束 🔥🔥🔥

  // ⭐⭐⭐ 自動儲存客戶資料 (原本的功能) ⭐⭐⭐
  try {
    const DATA_DIR = '/data';
    const USERS_FILE = path.join(DATA_DIR, 'users.json');

    // 確保目錄存在
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      logger.logToFile(`✅ 已建立 /data 目錄`);
    }

    // 確保檔案存在
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
      logger.logToFile(`✅ 已建立 users.json 檔案`);
    }

    // 讀取現有客戶資料
    let userList = [];
    try {
      const fileContent = fs.readFileSync(USERS_FILE, 'utf8');
      userList = JSON.parse(fileContent);
    } catch (e) {
      logger.logToFile(`⚠️ 讀取 users.json 失敗，使用空陣列`);
      userList = [];
    }

    // 檢查客戶是否已存在
    const existIndex = userList.findIndex(u => u.userId === userId);
    const timestamp = new Date().toISOString();

    if (existIndex >= 0) {
      // 更新現有客戶
      userList[existIndex] = {
        userId: userId,
        name: userName,
        lastUpdate: timestamp,
        createdAt: userList[existIndex].createdAt || timestamp
      };
      logger.logToFile(`♻️ 更新客戶資料: ${userName} (${userId})`);
    } else {
      // 新增客戶
      userList.push({
        userId: userId,
        name: userName,
        createdAt: timestamp,
        lastUpdate: timestamp
      });
      logger.logToFile(`➕ 新增客戶資料: ${userName} (${userId})`);
    }

    // 寫回檔案
    fs.writeFileSync(USERS_FILE, JSON.stringify(userList, null, 2), 'utf8');
    logger.logToFile(`💾 已將客戶資料寫入 /data/users.json (總共 ${userList.length} 筆)`);

    // 同時也存進 customerDB（雙重備份）
    try {
      await customerDB.saveCustomer(userId, userName);
    } catch (e) {
      logger.logToFile(`⚠️ customerDB 同步失敗: ${e.message}`);
    }
  } catch (saveError) {
    // ⚠️ 重要：儲存客戶資料失敗不應影響付款流程，只記錄錯誤
    logger.logError('儲存客戶資料失敗（不影響付款流程）', saveError);
  }
  // ⭐⭐⭐ 客戶資料儲存結束 ⭐⭐⭐

  // ====== 開始處理付款連結 ======
  try {
    const type = paymentType || 'both';

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    let finalMessage = '';
    let ecpayLink = '';
    let linepayLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    // 🔥 決定單號：如果有抓到 #單號 就用它，沒有就自動產生亂碼 🔥
    const commonOrderId = manualOrderId || `ORDER${Date.now()}`;

    // --- 1. 綠界 (ECPay) ---
    if (type === 'ecpay' || type === 'both') {
      // 若有指定單號，就用指定的；否則產生 EC 開頭亂碼
      ecpayOrderId = manualOrderId ? manualOrderId : `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      logger.logToFile(`建立綠界訂單: ${ecpayOrderId}`);

      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = ecpayPersistentUrl;

      try {
        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const result = await response.text();
        if (result && result.startsWith('http')) ecpayLink = result;
      } catch {
        logger.logToFile(`短網址生成失敗,使用原網址`);
      }
    }

    // --- 2. LINE Pay ---
    if (type === 'linepay' || type === 'both') {
      // 🔥 若有指定單號，就強制讓 Line Pay 使用這個單號 (讓 Python 機器人認得)
      linePayOrderId = manualOrderId ? manualOrderId : `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

      // 建立交易
      // ⚠️ 關鍵：這裡傳進去的 linePayOrderId 就是將來 Python 會收到的 ID
      const linePayResult = await createLinePayPayment(userId, userName, numAmount, linePayOrderId);

      if (linePayResult.success) {
        orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount });

        const paymentUrl = linePayResult.paymentUrlApp || linePayResult.paymentUrlWeb || linePayResult.paymentUrl;
        orderManager.updatePaymentInfo(linePayOrderId, {
          linepayTransactionId: linePayResult.transactionId,
          linepayPaymentUrl: paymentUrl,
          lastLinePayRequestAt: Date.now()
        });

        const persistentUrl = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
        linepayLink = persistentUrl; 
        logger.logToFile(`建立 LINE Pay 訂單(PERSISTENT): ${linePayOrderId}`);
      }
    }

    // --- 3. 組合回傳訊息 ---
    const userMsg = customMessage || '';
    
    // 如果有指定單號，在訊息裡偷標註一下，方便你確認
    const orderNote = manualOrderId ? `(單號:${manualOrderId})` : '';

    if (type === 'both' && ecpayLink && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n金額:NT$ ${numAmount.toLocaleString()}\n\n請選擇付款方式:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'ecpay' && ecpayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n付款方式:信用卡\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'linepay' && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n付款方式:LINE Pay\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else {
      return res.status(500).json({ error: '付款連結生成失敗' });
    }

    await client.pushMessage(userId, { type: 'text', text: finalMessage });
    logger.logToFile(`已發送付款連結: ${userName} - ${numAmount}元 (${type})`);

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
        customMessage: userMsg
      }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '發送失敗', details: err.message });
  }
});

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

app.get('/liff/payment', (req, res) => {
  res.sendFile('liff-payment.html', { root: './public' });
});

// 讓 LIFF 永遠拿到可用的 LINE Pay 連結：舊的>15分鐘就重建
app.get('/api/linepay/url/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'];
  const ref = req.headers['referer'] || 'no-ref';
  logger.logToFile(`[LINEPAY][LIFF_GET_URL_HIT] ip=${ip} ua="${ua}" ref="${ref}" method=${req.method} path=${req.path} extra=${JSON.stringify({orderId})}`);

  if (!order) {
    return res.json({ success: false, error: '找不到訂單' });
  }
  if (order.status === 'paid') {
    return res.json({ success: false, error: '訂單已付款' });
  }

  try {
    const now = Date.now();
    const last = order.lastLinePayRequestAt || 0;
    const elapsed = now - last;
    const EXPIRE_MS = 15 * 60 * 1000; // 15 分鐘（僅用於重建檢查，不影響你 168 小時訂單有效期）

    // 若已有連結且仍在 15 分鐘內 → 直接用
    if (order.linepayPaymentUrl && elapsed < EXPIRE_MS) {
      logger.logToFile(`LIFF: 重用既有連結 ${orderId}（${Math.floor(elapsed / 1000)} 秒內）`);
      return res.json({ success: true, paymentUrl: order.linepayPaymentUrl });
    }

    // 沒有連結或已逾 15 分鐘 → 重建
    logger.logToFile(`LIFF: 重新建立 LINE Pay 連結 ${orderId}（elapsed=${elapsed}ms）`);
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount, orderId);
    if (!lp?.success) {
      return res.json({ success: false, error: lp?.error || '建立 LINE Pay 交易失敗' });
    }

   const urlApp = lp.paymentUrlApp || null;
const urlWeb = lp.paymentUrlWeb || null;
const urlAny = urlApp || urlWeb || lp.paymentUrl;


orderManager.updatePaymentInfo(orderId, {
  linepayTransactionId: lp.transactionId,
  linepayPaymentUrl: urlAny,      // 通用網址
  linepayPaymentUrlApp: urlApp,   // 儲存 app 連結
  linepayPaymentUrlWeb: urlWeb,   // 儲存 web 連結
  lastLinePayRequestAt: now
});

const ua = String(req.headers['user-agent'] || '');
const preferApp = /Line\/|LineApp/i.test(ua); // 在 LINE App 內用 app 連結
const chosenUrl = preferApp ? (urlApp || urlAny) : (urlWeb || urlAny);

logger.logToFile(`LIFF: 交易建立 ${lp.transactionId}`);
return res.json({ success: true, paymentUrl: chosenUrl });
} catch (error) {
  logger.logError('LIFF: 取得 LINE Pay URL 失敗', error);
  return res.json({ success: false, error: '系統錯誤' });
}
});


// ==========================================
// 🚀 新增功能：洗衣店地端同步 API
// ==========================================

// 1. 建立一個全域變數，用來暫存「已付款但尚未同步」的訂單
// 注意：如果 Railway 重啟，這個變數會清空。如果要永久保存，需要存到資料庫。
// 但對於即時同步來說，用記憶體陣列 (Array) 通常就夠用了。
global.pendingSyncOrders = [];

// 2. API: 讓店裡電腦查詢「有哪些新付款？」
app.get('/api/get-pending-payments', (req, res) => {
    res.json(global.pendingSyncOrders);
});

// 3. API: 店裡電腦同步完成後，呼叫這個把它刪掉
app.post('/api/mark-synced', (req, res) => {
    const { orderId } = req.body;
    console.log(`[Sync] 店裡電腦已同步訂單: ${orderId}`);
    
    // 從清單中移除這筆訂單
    global.pendingSyncOrders = global.pendingSyncOrders.filter(o => o.orderId !== orderId);
    
    res.json({ success: true });
});

// ==========================================
// 🚚 外送行程接收接口 (給 Python 機器人用的)
// ==========================================
// ==========================================
// 🚚 外送行程接收接口 (修正版：預設為未簽收 Pending)
// ==========================================
app.post('/api/create-delivery-task', async (req, res) => {
    try {
        const { orderNo, customerNo, name, userId, mobile, status } = req.body;
        
        console.log(`[API] 收到 POS 完工通知: ${name} (${orderNo})`);

        const fs = require('fs');
        const path = require('path');
        const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
        
        let deliveryData = { orders: [] };
        if (fs.existsSync(FILE_PATH)) {
            deliveryData = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        }

        const exists = deliveryData.orders.some(o => o.orderNo === orderNo);
        
        if (!exists) {
            deliveryData.orders.push({
                id: `DELIVERY_${Date.now()}`,
                orderNo,
                customerNumber: customerNo,
                customerName: name,
                mobile,
                // 🔥 這裡改了！改成 Pending 代表「待處理/未簽收」
                status: 'Pending', 
                createdAt: new Date().toISOString(),
                // 🔥 這裡確認是 false
                signed: false 
            });
            fs.writeFileSync(FILE_PATH, JSON.stringify(deliveryData, null, 2), 'utf8');
            console.log(`✅ 已加入外送行程 (未簽收): ${orderNo}`);
        } else {
            console.log(`⚠️ 訂單已存在，略過: ${orderNo}`);
        }

        res.status(200).json({ success: true, message: "已接收並加入行程" });

    } catch (error) {
        console.error("外送排程錯誤:", error);
        res.status(500).send("Server Error");
    }
});

// ========================================
// 🏠 收件排程 API
// ========================================

// 📥 自動新增收件排程
app.post('/api/pickup-schedule/auto-add', async (req, res) => {
  const { userId, userName, message, source, customerNumber } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    // 確保資料夾存在
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    
    // 載入現有資料
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    // 檢查今天是否已經記錄過
    const today = new Date().toISOString().split('T')[0];
    const existing = data.schedules.find(s => 
      s.userId === userId && 
      s.pickupDate === today && 
      s.status === 'pending'
    );
    
    if (existing) {
      return res.json({ 
        success: true, 
        message: '今天已記錄此客戶',
        alreadyExists: true 
      });
    }
    
    // 建立新記錄
    const schedule = {
      id: 'PICKUP' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase(),
      customerNumber: customerNumber || '未登記',
      customerName: userName,
      userId: userId,
      pickupDate: today,
      source: source, // 'customer' 或 'ai'
      originalMessage: message,
      note: '',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    data.schedules.push(schedule);
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ 
      success: true, 
      message: '✅ 已記錄到收件排程',
      schedule: schedule
    });
    
  } catch (error) {
    console.error('新增收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📋 取得收件排程列表
app.get('/api/pickup-schedule/orders', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    // 依日期分組
    const grouped = {};
    data.schedules.forEach(schedule => {
      const date = schedule.pickupDate;
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(schedule);
    });
    
    res.json({ 
      success: true, 
      schedules: data.schedules,
      grouped: grouped
    });
    
  } catch (error) {
    console.error('載入收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ 標記已收件（並通知客人）
app.post('/api/pickup-schedule/complete', async (req, res) => {
  const { id, notifyCustomer } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const schedule = data.schedules.find(s => s.id === id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    schedule.status = 'completed';
    schedule.completedAt = new Date().toISOString();
    
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    // 如果要通知客人
    if (notifyCustomer && schedule.userId) {
      await client.pushMessage(schedule.userId, {
        type: 'text',
        text: '✅ 您的衣物已收到！\n我們會盡快為您處理，完成後會再通知您取件 💙'
      });
    }
    
    res.json({ 
      success: true, 
      message: notifyCustomer ? '✅ 已標記完成並通知客人' : '✅ 已標記完成'
    });
    
  } catch (error) {
    console.error('標記完成失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🗑️ 刪除收件排程
app.delete('/api/pickup-schedule/order/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const index = data.schedules.findIndex(s => s.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    data.schedules.splice(index, 1);
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ success: true, message: '✅ 已刪除收件排程' });
    
  } catch (error) {
    console.error('刪除收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✏️ 編輯收件排程
app.post('/api/pickup-schedule/update', async (req, res) => {
  const { id, note, pickupDate } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const schedule = data.schedules.find(s => s.id === id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    if (note !== undefined) schedule.note = note;
    if (pickupDate !== undefined) schedule.pickupDate = pickupDate;
    
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ success: true, message: '✅ 已更新收件排程' });
    
  } catch (error) {
    console.error('更新收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📊 取得今日收件提醒
app.get('/api/pickup-schedule/today-alert', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const today = new Date().toISOString().split('T')[0];
    const todaySchedules = data.schedules.filter(s => 
      s.pickupDate === today && s.status === 'pending'
    );
    
    const aiCount = todaySchedules.filter(s => s.source === 'ai').length;
    const customerCount = todaySchedules.filter(s => s.source === 'customer').length;
    
    res.json({
      success: true,
      total: todaySchedules.length,
      aiCount: aiCount,
      customerCount: customerCount,
      schedules: todaySchedules
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器正在運行,端口:${PORT}`);
  logger.logToFile(`伺服器正在運行,端口:${PORT}`);

// 🧺 初始化取件追蹤
  pickupRoutes.setLineClient(client);
  setInterval(() => {
    pickupRoutes.chec
    kAndSendReminders();
  }, 60 * 60 * 1000);
  console.log('✅ 取件追蹤系統已啟動');
  try {
    await customerDB.loadAllCustomers();
    console.log('客戶資料載入完成');
  } catch (error) {
    console.error('客戶資料載入失敗:', error.message);
  }

  setInterval(() => {
    orderManager.cleanExpiredOrders();
  }, 24 * 60 * 60 * 1000);

  setInterval(async () => {
    const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
    if (ordersNeedingReminder.length === 0) return;

    logger.logToFile(`檢測到 ${ordersNeedingReminder.length} 筆訂單需要提醒`);

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    for (const order of ordersNeedingReminder) {
      try {
        const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${order.orderId}`;
        const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${order.orderId}`;

        let linepayShort = linepayPersistentUrl;
        let ecpayShort = ecpayPersistentUrl;

        try {
          const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
          const t1 = await r1.text();
          if (t1 && t1.startsWith('http')) linepayShort = t1;
        } catch {
          logger.logToFile(`LINE Pay 短網址生成失敗,使用原網址`);
        }

        try {
          const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
          const t2 = await r2.text();
          if (t2 && t2.startsWith('http')) ecpayShort = t2;
        } catch {
          logger.logToFile(`綠界短網址失敗，使用原網址`);
        }

        const reminderText =
          `溫馨付款提醒\n\n` +
          `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
          `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
          `【信用卡／綠界】\n${ecpayShort}\n\n` +
          `【LINE Pay】\n${linepayShort}\n\n` +
          `備註：以上連結有效期間內可重複點擊付款。\n` +
          `若已完成付款，請忽略此訊息。感謝您的支持 💙`;

        await client.pushMessage(order.userId, { type: 'text', text: reminderText });

        logger.logToFile(`自動發送付款提醒：${order.orderId} (第 ${order.reminderCount + 1} 次)`);
        orderManager.markReminderSent(order.orderId);
      } catch (error) {
        logger.logError(`自動提醒失敗: ${order.orderId}`, error);
      }
    }
  }, 2 * 60 * 60 * 1000);
});
// ====================================
// 每週 AI 客服分析報告
// ====================================
const cron = require('node-cron');
const weeklyAnalysis = require('./services/weeklyAnalysis');
const reportGenerator = require('./services/reportGenerator');

// 每週日晚上 8 點執行（台北時間）
cron.schedule('0 20 * * 0', async () => {
  console.log('🔍 開始生成每週 AI 客服分析報告...');
  
  try {
    // 1. 分析數據
    const analysis = await weeklyAnalysis.analyzeWeeklyData();
    
    if (!analysis || analysis.error) {
      console.log('⚠️ 週報生成失敗:', analysis?.error || '未知錯誤');
      return;
    }

    // 2. 生成優化建議
    console.log('💡 正在生成 AI 優化建議...');
    const suggestions = await reportGenerator.generateSuggestions(analysis);
    
    // 3. 格式化報告
    const report = reportGenerator.formatReport(analysis, suggestions);
    
    // 4. 發送到 LINE
    if (process.env.ADMIN_USER_ID) {
      await client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: report
      });
      console.log('✅ 週報已發送到 LINE');
    }
    
    logger.logToFile('✅ 週報生成成功');
    
  } catch (error) {
    console.error('❌ 週報生成失敗:', error);
    logger.logError('週報生成失敗', error);
  }
}, {
  timezone: "Asia/Taipei"
});

console.log('⏰ 每週報告排程已啟動（每週日 20:00）');
