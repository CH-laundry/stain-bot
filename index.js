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

// ====== Middleware ======
app.use('/files', express.static(FILE_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
// ✅ 將 debugStorage 掛在全域（不要放在路由內）
app.use('/debug', require('./services/debugStorage'));

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

// ====== API: 使用者資料 ======
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
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox' ? 'https://sandbox-api-pay.line.me' : 'https://api-pay.line.me'
};

function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// ====== [新增] 防重複互斥鎖 + 通用頁面渲染 ======
const linePayLocks = new Map(); // orderId -> Promise

async function withLinePayLock(orderId, fn) {
  if (linePayLocks.has(orderId)) {
    const err = new Error('DUPLICATE_LINEPAY_REQUEST');
    err.code = 'DUPLICATE_LINEPAY_REQUEST';
    throw err;
  }
  const p = (async () => {
    try { return await fn(); }
    finally { linePayLocks.delete(orderId); }
  })();
  linePayLocks.set(orderId, p);
  return p;
}

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

function renderLinePayPage(orderId, amount, remainingHours, paymentUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LINE Pay 付款</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:40px;background:linear-gradient(135deg,#06C755,#00B900);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:28px;max-width:480px;margin:0 auto;box-shadow:0 8px 32px rgba(0,0,0,0.2)}
h1{font-size:26px;margin-bottom:20px;font-weight:700}
.info{background:rgba(255,255,255,0.2);border-radius:12px;padding:16px;margin:20px 0;font-size:15px}
.btn{display:block;width:100%;padding:16px;background:#fff;color:#06C755;text-decoration:none;border-radius:12px;font-weight:700;margin-top:20px;font-size:17px;border:none;cursor:pointer;transition:all 0.2s}
.btn:active{transform:scale(0.98);opacity:0.8}
.btn.disabled{opacity:0.5;cursor:not-allowed}
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
  <div class="warning">
    ⚠️ 請在 <b>LINE App 內</b> 開啟此連結；若在外部瀏覽器可能無法付款
  </div>
  <button id="payBtn" class="btn" onclick="handlePay()">🔓 前往 LINE Pay 付款</button>
  <p class="note">點擊後請完成付款；<b style="color:#FFE66D">付款過程中請勿關閉頁面</b><br>完成後會自動通知我們</p>
</div>
<script>
let processing = false;
const paymentUrl = "${paymentUrl}";
function handlePay() {
  if (processing) { alert('處理中,請稍候...'); return; }
  processing = true;
  const btn = document.getElementById('payBtn');
  btn.classList.add('disabled'); btn.textContent = '⏳ 跳轉中...';
  setTimeout(function(){ window.location.href = paymentUrl; }, 300);
  setTimeout(function(){
    if (document.visibilityState === 'visible') {
      processing = false; btn.classList.remove('disabled'); btn.textContent = '🔓 前往 LINE Pay 付款';
    }
  }, 5000);
}
document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'visible' && processing) {
    setTimeout(function(){
      processing = false;
      const btn = document.getElementById('payBtn');
      btn.classList.remove('disabled'); btn.textContent = '🔓 前往 LINE Pay 付款';
    }, 2000);
  }
});
</script>
</body></html>`;
}

// ====== LINE Pay: 建立交易（不加 capture，回傳 app/web URL） ======
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
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel`
      }
      // 不加 options.payment.capture
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
      const txId = result.info?.transactionId;
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
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ====== LINE Webhook ======
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

// ====== Google OAuth 測試/授權 ======
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
  if (!code) return res.status(400).send('缺少授權碼');
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

// ====== 測試上傳（示例） ======
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

// ====== Log 下載 ======
app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

// ====== 推播測試 ======
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

// ====== 綠界付款頁（保留原功能） ======
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

// ====== ✅（唯一保留）LINE Pay 持久付款頁（重用 15 分鐘 + 互斥鎖 + 手動點擊） ======
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
    let paymentUrl = null;

    // 15 分鐘內重用既有交易
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        paymentUrl = order.linepayPaymentUrl;
        logger.logToFile(`↩️ 重用既有連結: ${orderId}（${Math.floor(elapsed / 1000)} 秒前建立）`);
      } else {
        logger.logToFile(`⏰ 既有連結已超過 15 分鐘，準備建立新交易: ${orderId}`);
      }
    }

    // 需要新交易時使用互斥鎖
    if (!paymentUrl) {
      const result = await withLinePayLock(orderId, async () => {
        logger.logToFile(`🔄 建立新 LINE Pay 交易: ${orderId}`);
        const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (!lp.success) return { ok: false, error: lp.error };

        const url = lp.paymentUrlApp || lp.paymentUrlWeb || lp.paymentUrl;
        orderManager.updatePaymentInfo(orderId, {
          linepayTransactionId: lp.transactionId,
          linepayPaymentUrl: url,
          lastLinePayRequestAt: Date.now()
        });

        logger.logToFile(`✅ 新交易建立: ${lp.transactionId}`);
        return { ok: true, paymentUrl: url };
      });

      if (!result.ok) {
        return res.status(500).send(renderErrorPage('生成失敗', result.error || '無法建立付款連結'));
      }
      paymentUrl = result.paymentUrl;
    }

    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    return res.send(renderLinePayPage(orderId, order.amount, remainingHours, paymentUrl));
  } catch (error) {
    if (error?.code === 'DUPLICATE_LINEPAY_REQUEST') {
      logger.logToFile(`⚠️ 阻擋重複請求: ${orderId}`);
      return res.status(429).send(renderErrorPage('請稍候', '付款頁面正在生成中<br>請勿重複點擊<br>請稍候 3 秒後重新整理'));
    }
    logger.logError('LINE Pay 付款頁面錯誤', error);
    return res.status(500).send(renderErrorPage('系統錯誤', '請稍後重試或聯繫客服'));
  }
});

// ====== LINE Pay 付款結果確認 ======
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);

  if (order && orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天</p></div></body></html>');
  }

  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const requestBody = { amount: parseInt(amount), currency: 'TWD' };
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
      if (order) {
        orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      }
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);

      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, {
          type: 'text',
          text:
            `🎉 收到 LINE Pay 付款通知\n\n` +
            `客戶姓名:${decodeURIComponent(userName)}\n` +
            `付款金額:NT$ ${parseInt(amount).toLocaleString()}\n` +
            `付款方式:LINE Pay\n` +
            `訂單編號:${orderId}\n` +
            `交易編號:${transactionId}\n\n` +
            `狀態:✅ 付款成功`
        });
      }

      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text:
            `✅ LINE Pay 付款成功\n\n` +
            `感謝 ${decodeURIComponent(userName)} 的支付\n` +
            `金額:NT$ ${parseInt(amount).toLocaleString()}\n` +
            `訂單編號:${orderId}\n\n` +
            `非常謝謝您\n感謝您的支持 💙`
        });
      }

      logger.logToFile(`✅ LINE Pay 付款成功: ${decodeURIComponent(userName)} - ${amount}元`);
      res.redirect('/payment/success');
    } else {
      logger.logToFile(`❌ LINE Pay 付款確認失敗: ${result.returnCode} - ${result.returnMessage}`);
      res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款失敗</title><style>body{font-family:sans-serif;text-align:center;padding:50px}h1{color:#e74c3c}</style></head><body><h1>❌ 付款失敗</h1><p>' + result.returnMessage + '</p><p>請聯繫客服處理</p></body></html>');
    }
  } catch (error) {
    logger.logError('LINE Pay 確認付款失敗', error);
    res.status(500).send('付款處理失敗');
  }
});

// ====== 訂單/統計 API ======
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

  if (!order) {
    return res.status(404).json({ success: false, error: '找不到此訂單' });
  }

  try {
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

    // 這裡改為只送「持久網址」，不主動新建交易
    const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    let ecpayShort = ecpayPersistentUrl;
    let linepayShort = linepayPersistentUrl;

    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayShort = t2;
    } catch {
      logger.logToFile(`⚠️ 綠界短網址失敗，使用原網址`);
    }

    try {
      const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
      const t1 = await r1.text();
      if (t1 && t1.startsWith('http')) linepayShort = t1;
    } catch {
      logger.logToFile(`⚠️ LINE Pay 短網址失敗，使用原網址`);
    }

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

// ====== 客戶編號/模板 API（保留原功能） ======
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

// ====== 發送付款（ECPay保留；LINE Pay 改為發「持久網址」） ======
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

    // ECPay：維持原本建立本地訂單 + 發持久網址
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, {
        userId: userId,
        userName: userName,
        amount: numAmount
      });
      logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);

      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = ecpayPersistentUrl;

      try {
        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const result = await response.text();
        if (result && result.startsWith('http')) {
          ecpayLink = result;
          logger.logToFile(`✅ 已縮短綠界持久付款網址`);
        }
      } catch (error) {
        logger.logToFile(`⚠️ 短網址生成失敗,使用原網址`);
      }
    }

    // LINE Pay：先建立交易（只一次），建本地訂單 + 記錄 lastLinePayRequestAt，對客戶發「持久網址」
    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);

      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;

        // 先建立本地訂單
        orderManager.createOrder(linePayOrderId, {
          userId: userId,
          userName: userName,
          amount: numAmount
        });

        // 立刻更新付款資訊（含時間戳，供 15 分鐘重用）
        const paymentUrl = linePayResult.paymentUrlApp || linePayResult.paymentUrlWeb || linePayResult.paymentUrl;
        orderManager.updatePaymentInfo(linePayOrderId, {
          linepayTransactionId: linePayResult.transactionId,
          linepayPaymentUrl: paymentUrl,
          lastLinePayRequestAt: Date.now()
        });
        logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linePayOrderId}`);

        // 發「持久網址」給用戶
        const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
        linepayLink = linepayPersistentUrl;

        try {
          const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
          const result = await response.text();
          if (result && result.startsWith('http')) {
            linepayLink = result;
            logger.logToFile(`✅ 已縮短 LINE Pay 持續付款網址`);
          }
        } catch (error) {
          logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址`);
        }
      } else {
        logger.logToFile(`❌ LINE Pay 付款請求失敗`);
      }
    }

    const userMessage = customMessage || '';

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

// ====== 綠界回調 ======
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
          text:
            `🎉 收到綠界付款通知\n\n` +
            `客戶姓名: ${userName}\n` +
            `付款金額: NT$ ${amount.toLocaleString()}\n` +
            `付款方式: ${getPaymentTypeName(PaymentType)}\n` +
            `付款時間: ${PaymentDate}\n` +
            `綠界訂單: ${MerchantTradeNo}\n\n` +
            `狀態: ✅ 付款成功`
        });
      }

      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text:
            `✅ 付款成功\n\n` +
            `感謝 ${userName} 的支付\n` +
            `金額: NT$ ${amount.toLocaleString()}\n` +
            `綠界訂單: ${MerchantTradeNo}\n\n` +
            `非常謝謝您\n感謝您的支持 💙`
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

// ====== 其他頁面 ======
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

// ====== Server 啟動 + 自動任務 ======
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

  // 自動提醒：✅ 僅發送持久網址，不主動新建 LINE Pay 交易
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
