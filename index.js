// index.js  —— LINE Pay 只走 appUrl 版（保留全部原功能）

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

/* ===========================
 *  0) Google sheet.json 初始化
 * =========================== */
if (process.env.GOOGLE_PRIVATE_KEY) {
  console.log(`正在初始化 sheet.json: 成功`);
  fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
  console.log(`sheet.json 初始化结束`);
} else {
  console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

const app = express();

/* ===========================
 *  A) 自有偵錯端點
 * =========================== */
app.get('/__routes', (req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(',').toUpperCase();
      routes.push(`${methods} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route) {
          const methods = Object.keys(h.route.methods).join(',').toUpperCase();
          routes.push(`${methods} ${h.route.path}`);
        }
      });
    }
  });
  res.type('text').send(routes.sort().join('\n'));
});

app.get('/__myip', async (req, res) => {
  try {
    const r = await fetch('https://ifconfig.me/ip');
    const ip = (await r.text()).trim();
    res.type('text').send(ip);
  } catch (e) {
    res.status(500).type('text').send('無法取得伺服器 IP');
  }
});

/* ===========================
 *  B) 第三方除錯（僅掛一次）
 * =========================== */
app.use('/debug-tools', require('./services/debugStorage'));

/* ===========================
 *  C) 靜態檔與中介
 * =========================== */
const FILE_ROOT = '/data/uploads';
fs.mkdirSync(FILE_ROOT, { recursive: true });
app.use('/files', express.static(FILE_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* ===========================
 *  D) LINE SDK
 * =========================== */
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

/* ===========================
 *  E) 基礎 API（客戶）
 * =========================== */
app.get('/api/users', (req, res) => {
  const users = customerDB.getAllCustomers();
  res.json({ total: users.length, users });
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
    res.json({ success: true, message: '名稱已更新', user });
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

/* ===========================
 *  F) LINE Pay 設定（僅 appUrl）
 * =========================== */
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl:
    process.env.LINE_PAY_API_URL ||
    (process.env.LINE_PAY_ENV === 'sandbox'
      ? 'https://sandbox-api-pay.line.me'
      : 'https://api-pay.line.me'),
};

function generateLinePaySignature(uri, body, nonce) {
  const message =
    LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto
    .createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
    .update(message)
    .digest('base64');
}

/**
 * 只回傳 appUrl（仍保留 webUrl 作為備用，但所有訊息與導向都用 appUrl）
 */
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId =
      'LP' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL =
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      process.env.PUBLIC_BASE_URL ||
      process.env.BASE_URL ||
      'https://stain-bot-production-2593.up.railway.app';

    const requestBody = {
      amount: Number(amount),
      currency: 'TWD',
      orderId,
      packages: [
        {
          id: orderId,
          amount: Number(amount),
          name: 'C.H精緻洗衣服務',
          products: [{ name: '洗衣清潔費用', quantity: 1, price: Number(amount) }],
        },
      ],
      redirectUrls: {
        // LINE Pay 會自動附加 ?transactionId=
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(
          userName
        )}&amount=${Number(amount)}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel`,
      },
    };

    const uri = '/v3/payments/request';
    const signature = generateLinePaySignature(uri, requestBody, nonce);

    const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature,
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();
    logger.logToFile(`LINE Pay request 回應: ${JSON.stringify(result)}`);

    if (result.returnCode === '0000') {
      const info = result.info || {};
      const paymentUrl = info.paymentUrl || {};
      const webUrl = paymentUrl.web || null;
      const appUrl = paymentUrl.app || null;

      // 關鍵：即使 webUrl 存在，我們也只使用 appUrl
      if (!appUrl) {
        logger.logToFile('❌ LINE Pay 未回傳 appUrl，無法走 App 付款');
        return { success: false, error: 'LINE Pay 未回傳 appUrl' };
      }

      logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
      return {
        success: true,
        orderId,
        transactionId: info.transactionId,
        paymentUrl: { app: appUrl, web: webUrl }, // 仍保存 web 供除錯
      };
    } else {
      logger.logToFile(
        `❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`
      );
      return {
        success: false,
        error: result.returnMessage || 'LINE Pay request failed',
        raw: result,
      };
    }
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

/* ===========================
 *  G) LINE Webhook
 * =========================== */
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
    for (const event of events) {
      try {
        if (event.type !== 'message' || !event.source.userId) continue;
        const userId = event.source.userId;
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

/* ===========================
 *  H) Google OAuth 測試
 * =========================== */
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
  if (!code) return res.status(400).send('缺少授權碼');

  try {
    await googleAuth.getTokenFromCode(code);
    logger.logToFile('✅ Google OAuth 授權成功');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>授權成功</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}</style></head>
    <body><div class="container"><h1>✅ 授權成功!</h1><p>Google Sheets 和 Drive 已成功連接</p><p>您可以關閉此視窗了</p></div></body></html>`);
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
      resource: {
        values: [
          [timestamp, 'OAuth 測試客戶', 'test@example.com', '測試地址', 'OAuth 2.0 寫入測試成功! ✅'],
        ],
      },
    });
    logger.logToFile('✅ Google Sheets OAuth 測試成功');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試成功</title>
      <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:600px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}a{color:#fff;text-decoration:underline}</style></head>
      <body><div class="container"><h1>✅ Google Sheets 寫入測試成功!</h1><p>已成功使用 OAuth 2.0 寫入資料到試算表</p><p>寫入時間: ${timestamp}</p>
      <p><a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}" target="_blank">點此查看試算表</a></p><p><a href="/">返回首頁</a></p></div></body></html>`);
  } catch (error) {
    logger.logError('Google Sheets 測試失敗', error);
    res.status(500).send(`測試失敗: ${error.message}<br><a href="/auth">重新授權</a>`);
  }
});

/* ===========================
 *  I) 上傳測試
 * =========================== */
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

/* ===========================
 *  J) 日誌下載
 * =========================== */
app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

/* ===========================
 *  K) 推播測試
 * =========================== */
app.get('/test-push', async (req, res) => {
  const userId = process.env.ADMIN_USER_ID || 'Uxxxxxxxxxxxxxxxxxxxx';
  try {
    await client.pushMessage(userId, { type: 'text', text: '✅ 測試推播成功!這是一則主動訊息 🚀' });
    res.send('推播成功,請查看 LINE Bot 訊息');
  } catch (err) {
    console.error('推播錯誤', err);
    res.status(500).send(`推播失敗: ${err.message}`);
  }
});

/* ===========================
 *  L) ECpay：持久連結
 * =========================== */
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head>
    <body><div class="container"><h1>❌ 訂單不存在</h1><p>找不到此訂單</p></div></body></html>`);
  }

  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}</style></head>
    <body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天(168 小時)</p><p>已過時間: ${Math.floor(hoursPassed)} 小時</p><p>訂單編號: ${orderId}</p><p>請聯繫 C.H 精緻洗衣客服重新取得訂單</p></div></body></html>`);
  }

  if (order.status === 'paid') {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head>
    <body><div class="container"><h1>✅ 訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ${orderId}</p></div></body></html>`);
  }

  try {
    logger.logToFile(`🔄 重新生成綠界付款連結: ${orderId}`);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往綠界付款</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head>
    <body><div class="container"><h1>💳 前往綠界付款</h1><div class="info"><p><strong>訂單編號:</strong> ${orderId}</p><p><strong>客戶姓名:</strong> ${order.userName}</p><p><strong>金額:</strong> NT$ ${order.amount.toLocaleString()}</p><p><strong>剩餘有效時間:</strong> ${remainingHours} 小時</p></div><p>⏰ 正在為您生成付款連結...</p><p>若未自動跳轉，請點擊下方按鈕</p><a href="${ecpayLink}" class="btn">立即前往綠界付款</a></div><script>setTimeout(function(){window.location.href="${ecpayLink}"},1500)</script></body></html>`);
    logger.logToFile(`✅ 綠界付款連結已重新生成: ${orderId}`);
  } catch (error) {
    logger.logError('重新生成綠界連結失敗', error);
    res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>❌ 付款連結生成失敗</h1><p>請聯繫客服處理</p></body></html>');
  }
});

/* ===========================
 *  M) LINE Pay：只走 appUrl 的持久連結
 * =========================== */
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = orderManager.getOrder(orderId);

    if (!order) return res.status(404).type('text').send('訂單不存在');
    if (orderManager.isExpired(orderId)) return res.status(410).type('text').send('訂單已過期');
    if (order.status === 'paid') return res.redirect('/payment/success');

    if (!order.linepayPaymentUrl || !order.linepayPaymentUrl.app) {
      const r = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!r.success) {
        return res.status(500).type('text').send('無法生成 LINE Pay 付款連結，請稍後重試');
      }
      orderManager.updatePaymentInfo(orderId, {
        linepayTransactionId: r.transactionId,
        linepayPaymentUrl: r.paymentUrl, // { app, web }
      });
      order.linepayPaymentUrl = r.paymentUrl;
    }

    const appUrl = order.linepayPaymentUrl.app;
    if (!appUrl) return res.status(500).type('text').send('付款連結缺失 (appUrl)，請稍後重試');

    // 無論 UA，統一導向 appUrl（在非 LINE/手機上會顯示提示頁）
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isMobile = /iphone|ipad|ipod|android|line/.test(ua);

    if (isMobile) {
      return res.redirect(appUrl);
    }

    // 桌面瀏覽器顯示提示頁（教使用者在手機 LINE 開啟）
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>LINE Pay App 支付</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff}a.btn{display:inline-block;margin-top:20px;padding:12px 22px;background:#06C755;color:#fff;border-radius:10px;text-decoration:none;font-weight:700}</style></head>
    <body><h1>請用手機 LINE 開啟此連結以完成付款</h1><p>或使用手機掃描本頁的 QR 後再打開</p><a class="btn" href="${appUrl}">打開 LINE Pay 支付（App）</a></body></html>`);
  } catch (e) {
    logger.logError('導向 LINE Pay 失敗', e);
    res.status(500).type('text').send('系統錯誤，請稍後重試');
  }
});

/* ===========================
 *  N) 取消 / 成功頁
 * =========================== */
app.get('/payment/linepay/cancel', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

app.get('/payment/success', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});

/* ===========================
 *  O) LINE Pay 付款完成確認（confirm）
 * =========================== */
app.get('/payment/linepay/confirm', async (req, res) => {
  try {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    if (!transactionId || !orderId) {
      return res.status(400).send('缺少必要參數');
    }
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: Number(amount), currency: 'TWD' };
    const nonce = crypto.randomBytes(16).toString('base64');
    const signature = generateLinePaySignature(uri, body, nonce);

    const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature,
      },
      body: JSON.stringify(body),
    });

    const result = await response.json();
    logger.logToFile(`LINE Pay confirm 回應: ${JSON.stringify(result)}`);

    if (result.returnCode === '0000') {
      logger.logToFile(`✅ LINE Pay 付款成功: ${orderId} (${userName})`);
      orderManager.updateOrderStatus(orderId, 'paid');
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text: `✅ 付款成功！\n感謝 ${userName} 的支付。\n金額 NT$${amount}`,
        });
      }
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款完成</title>
      <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}</style></head>
      <body><h1>✅ 付款完成</h1><p>訂單編號：${orderId}</p></body></html>`);
    } else {
      logger.logToFile(`❌ LINE Pay 確認失敗: ${result.returnMessage}`);
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款未完成</title>
      <style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}</style></head>
      <body><h1>❌ 付款未完成</h1><p>${result.returnMessage}</p></body></html>`);
    }
  } catch (err) {
    logger.logError('LINE Pay 確認階段出錯', err);
    res.status(500).send('系統錯誤');
  }
});

/* ===========================
 *  P) 發送付款（只用 LINE Pay appUrl；ECpay 保留）
 * =========================== */
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
    const type = paymentType || 'linepay-app'; // 預設只 LINE Pay app 流程
    const baseURL =
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      process.env.PUBLIC_BASE_URL ||
      process.env.BASE_URL ||
      'https://stain-bot-production-2593.up.railway.app';

    let finalMessage = '';
    let ecpayLink = '';
    let linepayAppLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, {
        userId,
        userName,
        amount: numAmount,
      });
      logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);

      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = ecpayPersistentUrl;
    }

    if (type === 'linepay-app' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);
      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;
        orderManager.createOrder(linePayResult.orderId, {
          userId,
          userName,
          amount: numAmount,
        });
        orderManager.updatePaymentInfo(linePayResult.orderId, {
          linepayTransactionId: linePayResult.transactionId,
          linepayPaymentUrl: linePayResult.paymentUrl, // { app, web }
        });
        logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linePayOrderId}`);
        // 只取 appUrl
        linepayAppLink = linePayResult.paymentUrl.app;
      } else {
        logger.logToFile(`❌ LINE Pay 付款請求失敗：${linePayResult.error}`);
      }
    }

    // 準備訊息 —— 僅給 appUrl（必要時保留文案）
    const userMsg = customMessage || '';
    if ((type === 'linepay-app' || type === 'both') && linepayAppLink) {
      finalMessage =
        userMsg ||
        `💙 您好，${userName}\n\n您的專屬付款連結已生成\n付款方式：LINE Pay（App）\n金額：NT$ ${numAmount.toLocaleString()}\n\n請點擊下方按鈕於手機 LINE 直接付款。`;
      // 推 Flex：只含「用 LINE Pay 支付（App）」按鈕
      const flex = {
        type: 'flex',
        altText: 'LINE Pay 付款連結',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: 'C.H 精緻洗衣', weight: 'bold', size: 'lg' },
              { type: 'text', text: `金額 NT$ ${numAmount.toLocaleString()}`, margin: 'md' },
              { type: 'text', text: '付款方式：LINE Pay（App）', size: 'sm', color: '#888888', margin: 'sm' },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#06C755',
                action: { type: 'uri', label: '用 LINE Pay 支付（App）', uri: linepayAppLink },
              },
            ],
          },
        },
      };
      await client.pushMessage(userId, { type: 'text', text: finalMessage });
      await client.pushMessage(userId, flex);
    }

    if (type === 'ecpay' && ecpayLink) {
      const text =
        userMsg ||
        `💙 您好，${userName}\n\n您的專屬付款連結已生成\n付款方式：信用卡（綠界）\n金額：NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款：\n${ecpayLink}`;
      await client.pushMessage(userId, { type: 'text', text });
    }

    if (!linepayAppLink && type !== 'ecpay') {
      return res.status(500).json({ error: 'LINE Pay appUrl 生成失敗' });
    }

    res.json({
      success: true,
      message: '付款連結已發送',
      data: {
        userId,
        userName,
        amount: numAmount,
        paymentType: type,
        ecpayLink: ecpayLink || null,
        linepayAppLink: linepayAppLink || null,
        ecpayOrderId: ecpayOrderId || null,
        linePayOrderId: linePayOrderId || null,
        customMessage: userMsg,
      },
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '發送失敗', details: err.message });
  }
});

/* ===========================
 *  Q) ECpay Callback（保留原功能）
 * =========================== */
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
      CustomField2: userName,
    } = req.body;

    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
      logger.logToFile(`✅ 綠界付款成功,已標記 ${updated} 筆訂單為已付款`);

      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, {
          type: 'text',
          text: `🎉 收到綠界付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${amount.toLocaleString()}\n付款方式: ${getPaymentTypeName(PaymentType)}\n付款時間: ${PaymentDate}\n綠界訂單: ${MerchantTradeNo}\n\n狀態: ✅ 付款成功`,
        });
      }

      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${amount.toLocaleString()}\n綠界訂單: ${MerchantTradeNo}\n\n非常謝謝您\n感謝您的支持 💙`,
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
    Credit_CreditCard: '信用卡',
    ATM_LAND: 'ATM 轉帳',
    CVS_CVS: '超商代碼',
    BARCODE_BARCODE: '超商條碼',
    WebATM_TAISHIN: '網路 ATM',
  };
  return types[code] || code;
}

/* ===========================
 *  R) 其他保留 API
 * =========================== */
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
    uptime: process.uptime(),
  });
});

/* ===========================
 *  S) 啟動與排程（清理 + 自動提醒）
 * =========================== */
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

  // 2 分鐘掃描一次需要提醒的訂單（保留功能）
  setInterval(async () => {
    const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
    if (ordersNeedingReminder.length === 0) return;

    logger.logToFile(`🔔 檢測到 ${ordersNeedingReminder.length} 筆訂單需要提醒`);

    for (const order of ordersNeedingReminder) {
      try {
        const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);

        if (linePayResult.success) {
          const paymentData = {
            linepayTransactionId: linePayResult.transactionId,
            linepayPaymentUrl: linePayResult.paymentUrl, // { app, web }
          };
          orderManager.updatePaymentInfo(order.orderId, paymentData);

          // 僅送 appUrl
          const appUrl = linePayResult.paymentUrl.app;

          const reminderText =
            `😊 溫馨付款提醒\n\n` +
            `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
            `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
            `【LINE Pay（App）】請點擊下方按鈕於手機 LINE 直接付款。\n`;

          // Flex 按鈕
          const flex = {
            type: 'flex',
            altText: '付款提醒：LINE Pay',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: '付款提醒', weight: 'bold', size: 'lg' },
                  { type: 'text', text: `金額 NT$ ${order.amount.toLocaleString()}`, margin: 'md' },
                ],
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#06C755',
                    action: { type: 'uri', label: '用 LINE Pay 支付（App）', uri: appUrl },
                  },
                ],
              },
            },
          };

          await client.pushMessage(order.userId, { type: 'text', text: reminderText });
          await client.pushMessage(order.userId, flex);

          logger.logToFile(`✅ 自動發送付款提醒（LINE Pay App）：${order.orderId} (第 ${order.reminderCount + 1} 次)`);
          orderManager.markReminderSent(order.orderId);
        } else {
          logger.logToFile(`❌ 自動提醒失敗,無法生成 LINE Pay appUrl: ${order.orderId}`);
        }
      } catch (error) {
        logger.logError(`自動提醒失敗: ${order.orderId}`, error);
      }
    }
  }, 2 * 60 * 1000);
});
