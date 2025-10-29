// ====== Bootstraps / 基礎設定 ======
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

// ★ 你的 LIFF ID（按你的需求：用常數名 YOUR_LIFF_ID）
const YOUR_LIFF_ID = '2008313382-3Xna6abB';

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
fs.mkdirSync(FILE_ROOT, { recursive: true });

// ====== Middleware ======
app.use('/files', express.static(FILE_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/debug', require('./services/debugStorage')); // 保留

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

// ====== 使用者資料 API（保留） ======
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

// ====== LINE Pay 設定/簽名 ======
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
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
  <h1>⚠️ ${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

// 🔧 不自動跳轉，純 <a> 按鈕
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
  <h1>💳 LINE Pay 付款</h1>
  <div class="info">
    <div>訂單: ${orderId}</div>
    <div style="font-size:24px;font-weight:700;margin:12px 0">NT$ ${amount.toLocaleString()}</div>
    <div>有效期: ${remainingHours} 小時</div>
  </div>
  <div class="warning">⚠️ 點擊按鈕後將前往 LINE Pay 完成付款，完成後系統會自動通知。</div>
  <a href="${paymentUrl}" class="btn">🔓 前往 LINE Pay 付款</a>
  <p class="note">請勿重複點擊；若已付款，稍後會收到成功通知。</p>
</div>
</body></html>`;
}

// ====== 建立 LINE Pay 交易 ======
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

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
      redirectUrls: {
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel?orderId=${orderId}`
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
    logger.logToFile(`📥 LINE Pay API: ${result.returnCode} - ${result.returnMessage}`);

    if (result.returnCode === '0000') {
      const paymentUrlApp = result.info?.paymentUrl?.app || null;
      const paymentUrlWeb = result.info?.paymentUrl?.web || null;
      const txId = result.info?.transactionId || null;
      const pickUrl = paymentUrlApp || paymentUrlWeb;

      logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
      return {
        success: true,
        paymentUrlApp,
        paymentUrlWeb,
        paymentUrl: pickUrl,
        orderId,
        transactionId: txId
      };
    } else {
      logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
      return { success: false, error: result.returnMessage || 'LINE Pay 請求失敗' };
    }
  } catch (error) {
    logger.logError('LINE Pay 請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ====== LINE Webhook（保留） ======
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events;
    for (const event of events) {
      try {
        if (event.type !== 'message' || !event.source.userId) continue;
        const userId = event.source.userId;
        await saveUserProfile(userId);

        if (event.message.type === 'text') {
          const userMessage = event.message.text.trim();
          logger.logUserMessage(userId, userMessage);
          await messageHandler.handleTextMessage(userId, userMessage, userMessage);
        } else if (event.message.type === 'image') {
          logger.logUserMessage(userId, '上傳了一張圖片');
          await messageHandler.handleImageMessage(userId, event.message.id);
        } else if (event.message.type === 'sticker') {
          logger.logUserMessage(userId, `發送了貼圖 (${event.message.stickerId})`);
        } else {
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

// ====== Google OAuth（保留） ======
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
    logger.logToFile('✅ Google OAuth 授權成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>授權成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}</style></head><body><div class="container"><h1>✅ 授權成功!</h1><p>Google Sheets 和 Drive 已成功連接</p><p>您可以關閉此視窗了</p></div></body></html>');
  } catch (error) {
    logger.logError('處理授權碼失敗', error);
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
      resource: { values: [[timestamp, 'OAuth 測試客戶', 'test@example.com', '測試地址', 'OAuth 2.0 寫入測試成功! ✅']] }
    });
    logger.logToFile('✅ Google Sheets OAuth 測試成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:600px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}a{color:#fff;text-decoration:underline}</style></head><body><div class="container"><h1>✅ Google Sheets 寫入測試成功!</h1><p>已成功使用 OAuth 2.0 寫入資料到試算表</p><p>寫入時間: ' + timestamp + '</p><p><a href="https://docs.google.com/spreadsheets/d/' + spreadsheetId + '" target="_blank">點此查看試算表</a></p><p><a href="/">返回首頁</a></p></div></body></html>');
  } catch (error) {
    logger.logError('Google Sheets 測試失敗', error);
    res.status(500).send(`測試失敗: ${error.message}<br><a href="/auth">重新授權</a>`);
  }
});

// ====== 測試上傳（保留） ======
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
      logger.logToFile(`✅ ${typeLabel}測試上傳成功: ${filename}`);
      res.json({ success: true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== Log 下載（保留） ======
app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

// ====== 推播測試（保留） ======
app.get('/test-push', async (req, res) => {
  const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx";
  try {
    await client.pushMessage(userId, { type: 'text', text: '✅ 測試推播成功!這是一則主動訊息 🚀' });
    res.send("推播成功,請查看 LINE Bot 訊息");
  } catch (err) {
    console.error("推播錯誤", err);
    res.status(500).send(`推播失敗: ${err.message}`);
  }
});

// ====== 綠界付款頁（保留） ======
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

app.get('/payment/success', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});

app.get('/payment/linepay/cancel', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

// ====== 綠界持久付款頁（保留原邏輯） ======
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 訂單不存在</h1><p>找不到此訂單</p></div></body></html>');
  }

  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天(168 小時)</p><p>已過時間: ' + Math.floor(hoursPassed) + ' 小時</p><p>訂單編號: ' + orderId + '</p><p>請聯繫 C.H 精緻洗衣客服重新取得訂單</p></div></body></html>');
  }

  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ' + orderId + '</p></div></body></html>');
  }

  try {
    logger.logToFile(`🔄 重新生成綠界付款連結: ${orderId}`);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往綠界付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head><body><div class="container"><h1>💳 前往綠界付款</h1><div class="info"><p><strong>訂單編號:</strong> ' + orderId + '</p><p><strong>客戶姓名:</strong> ' + order.userName + '</p><p><strong>金額:</strong> NT$ ' + order.amount.toLocaleString() + '</p><p><strong>剩餘有效時間:</strong> ' + remainingHours + ' 小時</p></div><p>⏰ 正在為您生成付款連結...</p><p>若未自動跳轉，請點擊下方按鈕</p><a href="' + ecpayLink + '" class="btn">立即前往綠界付款</a></div><script>setTimeout(function(){window.location.href="' + ecpayLink + '"},1500)</script></body></html>');
    logger.logToFile(`✅ 綠界付款連結已重新生成: ${orderId}`);
  } catch (error) {
    logger.logError('重新生成綠界連結失敗', error);
    res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>❌ 付款連結生成失敗</h1><p>請聯繫客服處理</p></body></html>');
  }
});

// ====== ✅ LINE Pay 持久付款頁（不自動跳轉，15 分鐘重用） ======
const creatingTransactions = new Set(); // orderId 集合

app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(renderErrorPage('訂單不存在', '找不到此訂單'));
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send(renderErrorPage('訂單已過期', `此訂單已超過 7 天<br>訂單編號: ${orderId}`));
  }
  if (order.status === 'paid') {
    return res.send(renderErrorPage('訂單已付款', `此訂單已完成付款<br>訂單編號: ${orderId}`));
  }

  try {
    // 15 分鐘內重用
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        logger.logToFile(`↩️ 重用既有連結: ${orderId}（${Math.floor(elapsed / 1000)} 秒前建立）`);
        const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
        return res.send(renderLinePayPage(orderId, order.amount, remainingHours, order.linepayPaymentUrl));
      }
    }

    // 正在建立：等 1 秒再查一次，避免無限循環
    if (creatingTransactions.has(orderId)) {
      logger.logToFile(`⏳ 建立中: ${orderId}，等待 1 秒再查`);
      await new Promise(r => setTimeout(r, 1000));
      const fresh = orderManager.getOrder(orderId);
      if (fresh.linepayTransactionId && fresh.linepayPaymentUrl) {
        const elapsed2 = Date.now() - (fresh.lastLinePayRequestAt || 0);
        if (elapsed2 < 15 * 60 * 1000) {
          logger.logToFile(`↩️ 使用剛建立的連結: ${orderId}`);
          const remainingHours = Math.floor((fresh.expiryTime - Date.now()) / (1000 * 60 * 60));
          return res.send(renderLinePayPage(orderId, fresh.amount, remainingHours, fresh.linepayPaymentUrl));
        }
      }
      return res.status(503).send(renderErrorPage('付款連結建立中', '正在為您建立付款連結<br>請稍候 2 秒後重新整理'));
    }

    // 建立新交易（鎖立即清除）
    creatingTransactions.add(orderId);
    try {
      logger.logToFile(`🔄 建立新 LINE Pay 交易: ${orderId}`);
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!lp.success) {
        return res.status(500).send(renderErrorPage('生成失敗', lp.error || '無法建立付款連結'));
      }

      const url = lp.paymentUrlApp || lp.paymentUrlWeb || lp.paymentUrl;
      orderManager.updatePaymentInfo(orderId, {
        linepayTransactionId: lp.transactionId,
        linepayPaymentUrl: url,
        lastLinePayRequestAt: Date.now()
      });
      logger.logToFile(`✅ 新交易建立: ${lp.transactionId}`);

      const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
      return res.send(renderLinePayPage(orderId, order.amount, remainingHours, url));
    } finally {
      creatingTransactions.delete(orderId);
    }
  } catch (error) {
    creatingTransactions.delete(orderId);
    logger.logError('LINE Pay 付款頁面錯誤', error);
    return res.status(500).send(renderErrorPage('系統錯誤', '請稍後重試或聯繫客服'));
  }
});

// ====== LINE Pay 付款結果確認 ======
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId } = req.query;
  logger.logToFile(`📥 收到 LINE Pay Confirm 回調: orderId=${orderId}, transactionId=${transactionId}`);

  const order = orderManager.getOrder(orderId);
  if (!order) {
    logger.logToFile(`❌ 找不到訂單: ${orderId}`);
    return res.status(404).send(renderErrorPage('訂單不存在', '找不到此訂單'));
  }
  if (orderManager.isExpired(orderId)) {
    return res.send(renderErrorPage('訂單已過期', '此訂單已超過有效期'));
  }
  if (order.status === 'paid') {
    logger.logToFile(`⚠️ 訂單已付款: ${orderId}`);
    return res.redirect('/payment/success');
  }

  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const requestBody = { amount: parseInt(order.amount), currency: 'TWD' };
    const signature = generateLinePaySignature(uri, requestBody, nonce);

    logger.logToFile(`📤 呼叫 Confirm API: tx=${transactionId}, amount=${order.amount}`);
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
    logger.logToFile(`📥 Confirm 回應: ${result.returnCode} - ${result.returnMessage}`);

    if (result.returnCode === '0000') {
      orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 付款成功: ${order.userName} - ${order.amount}元 - 訂單: ${orderId}`);

      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, {
          type: 'text',
          text:
            `🎉 收到 LINE Pay 付款通知\n\n` +
            `客戶姓名:${order.userName}\n` +
            `付款金額:NT$ ${parseInt(order.amount).toLocaleString()}\n` +
            `付款方式:LINE Pay\n` +
            `訂單編號:${orderId}\n` +
            `交易編號:${transactionId}\n\n` +
            `狀態:✅ 付款成功`
        });
      }

      if (order.userId && order.userId !== 'undefined') {
        await client.pushMessage(order.userId, {
          type: 'text',
          text:
            `✅ LINE Pay 付款成功\n\n` +
            `感謝 ${order.userName} 的支付\n` +
            `金額:NT$ ${parseInt(order.amount).toLocaleString()}\n` +
            `訂單編號:${orderId}\n\n` +
            `非常謝謝您\n感謝您的支持 💙`
        });
      }

      res.redirect('/payment/success');
    } else {
      logger.logToFile(`❌ Confirm 失敗: ${result.returnCode} - ${result.returnMessage}`);
      res.send(renderErrorPage('付款失敗', result.returnMessage));
    }
  } catch (error) {
    logger.logError('LINE Pay 確認付款失敗', error);
    res.status(500).send('付款處理失敗');
  }
});

// ====== 訂單/統計 API（保留） ======
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
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    let ecpayShort = ecpayPersistentUrl;
    let linepayShort = linepayPersistentUrl;

    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayShort = t2;
    } catch { logger.logToFile(`⚠️ 綠界短網址失敗，使用原網址`); }

    try {
      const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
      const t1 = await r1.text();
      if (t1 && t1.startsWith('http')) linepayShort = t1;
    } catch { logger.logToFile(`⚠️ LINE Pay 短網址失敗,使用原網址`); }

    await client.pushMessage(order.userId, {
      type: 'text',
      text:
        `🔄 付款連結已重新生成（持久網址）\n\n` +
        `訂單編號: ${orderId}\n客戶姓名: ${order.userName}\n金額: NT$ ${order.amount.toLocaleString()}\n\n` +
        `— 請選擇付款方式 —\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結可重複點擊，隨時都可以付款。\n` +
        `✅ 付款後系統會自動通知我們`
    });

    orderManager.markReminderSent(orderId);
    logger.logToFile(`✅ 單筆續約重發（綠界+LINE Pay 持久網址）：${orderId}`);

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

// ====== 批次提醒（只發持久網址，不新建交易） ======
app.post('/api/orders/send-reminders', async (req, res) => {
  const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
  if (ordersNeedingReminder.length === 0) {
    return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });
  }

  let sent = 0;
  const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

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
        `😊 溫馨付款提醒\n\n` +
        `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
        `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結有效期間內可重複點擊付款。\n` +
        `若已完成付款，請忽略此訊息。感謝您的支持 💙`;

      await client.pushMessage(order.userId, { type: 'text', text: reminderText });

      sent++;
      orderManager.markReminderSent(order.orderId);
      logger.logToFile(`✅ 已發送付款提醒：${order.orderId} (第 ${order.reminderCount} 次)`);
    } catch (error) {
      logger.logError(`發送提醒失敗: ${order.orderId}`, error);
    }
  }

  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent: sent });
});

app.get('/api/orders/statistics', (req, res) => {
  res.json({ success: true, statistics: orderManager.getStatistics() });
});

// ====== 客戶編號/模板 API（保留） ======
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

// ====== 發送付款（ECPay 保留；LINE Pay 改用 LIFF URL） ======
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);

  if (!userId || !userName || !amount) {
    logger.logToFile(`❌ 參數驗證失敗`);
    return res.status(400).json({ error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }

  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: '金額必須是正整數' });
  }

  try {
    const type = paymentType || 'both';
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    let finalMessage = '';
    let ecpayLink = '';
    let linepayLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    // ECPay
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);

      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = ecpayPersistentUrl;

      try {
        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const result = await response.text();
        if (result && result.startsWith('http')) ecpayLink = result;
      } catch {
        logger.logToFile(`⚠️ 短網址生成失敗,使用原網址`);
      }
    }

    // ====== ★ 你提供的「第 4 點」：LINE Pay 改成 LIFF URL ======
    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);

      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;

        orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount });

        const paymentUrl = linePayResult.paymentUrlApp || linePayResult.paymentUrlWeb || linePayResult.paymentUrl;
        orderManager.updatePaymentInfo(linePayOrderId, {
          linepayTransactionId: linePayResult.transactionId,
          linepayPaymentUrl: paymentUrl,
          lastLinePayRequestAt: Date.now()
        });

        // ✅ 使用 LIFF URL 取代直接的 LINE Pay URL
        const liffUrl = `https://liff.line.me/${YOUR_LIFF_ID}?orderId=${linePayOrderId}`;
        linepayLink = liffUrl;

        logger.logToFile(`✅ 建立 LINE Pay 訂單(LIFF): ${linePayOrderId}`);
      }
    }
    // ====== ★ 第 4 點整合結束 ======

    const userMsg = customMessage || '';
    if (type === 'both' && ecpayLink && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結如下:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成\n金額:NT$ ${numAmount.toLocaleString()}\n\n請選擇付款方式:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'ecpay' && ecpayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結如下:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成\n付款方式:信用卡\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'linepay' && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結如下:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
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
        customMessage: userMsg
      }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '發送失敗', details: err.message });
  }
});

// ====== 其他頁面（保留） ======
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

/* ========= ★★★ 新增：LIFF 相關路由 ★★★ ========= */

// LIFF 付款頁（Endpoint URL: /liff/payment）
app.get('/liff/payment', (req, res) => {
  res.sendFile('liff-payment.html', { root: './public' });
});

// 由 LIFF 前端取得（或重用）LINE Pay 付款 URL
app.get('/api/linepay/url/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.json({ success: false, error: '找不到訂單' });
  }
  if (order.status === 'paid') {
    return res.json({ success: false, error: '訂單已付款' });
  }

  try {
    // 15 分鐘內重用
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        logger.logToFile(`↩️ LIFF: 重用連結 ${orderId}`);
        return res.json({ success: true, paymentUrl: order.linepayPaymentUrl });
      }
    }

    // 新建交易
    logger.logToFile(`🔄 LIFF: 建立新交易 ${orderId}`);
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);

    if (!lp.success) {
      return res.json({ success: false, error: lp.error });
    }

    const url = lp.paymentUrlApp || lp.paymentUrlWeb || lp.paymentUrl;

    orderManager.updatePaymentInfo(orderId, {
      linepayTransactionId: lp.transactionId,
      linepayPaymentUrl: url,
      lastLinePayRequestAt: Date.now()
    });

    logger.logToFile(`✅ LIFF: 交易建立 ${lp.transactionId}`);
    res.json({ success: true, paymentUrl: url });
  } catch (error) {
    logger.logError('LIFF: 取得 LINE Pay URL 失敗', error);
    res.json({ success: false, error: '系統錯誤' });
  }
});

/* ========= ★★★ 新增結束 ★★★ ========= */

// ====== Server 啟動 + 自動任務（保留） ======
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

  // 每日清理過期訂單
  setInterval(() => {
    orderManager.cleanExpiredOrders();
  }, 24 * 60 * 60 * 1000);

  // 自動提醒：只發持久網址，不主動新建 LINE Pay 交易
  setInterval(async () => {
    const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
    if (ordersNeedingReminder.length === 0) return;

    logger.logToFile(`🔔 檢測到 ${ordersNeedingReminder.length} 筆訂單需要提醒`);
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

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
          logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址`);
        }

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

        await client.pushMessage(order.userId, { type: 'text', text: reminderText });

        logger.logToFile(`✅ 自動發送付款提醒：${order.orderId} (第 ${order.reminderCount + 1} 次)`);
        orderManager.markReminderSent(order.orderId);
      } catch (error) {
        logger.logError(`自動提醒失敗: ${order.orderId}`, error);
      }
    }
  }, 2 * 60 * 1000);
});
