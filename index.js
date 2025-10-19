/*********************************************************
 * C.H 精緻洗衣 付款系統 — 單檔完整後端
 * - LINE Bot / LINE Pay / 綠界信用卡（ECPay, 轉頁）
 * - 訂單資料持久化(data/orders.json)
 * - 客戶資料 API (編號/姓名/UserID) 讀寫刪
 * - 訊息模板 API 讀/增/改/刪
 * - 「永久入口」LINE Pay：/payment/linepay/pay/:orderId
 * - 短網址＋訊息內以「綠界信用卡」「LINE Pay」中文字樣呈現
 * - 自動提醒：每 2 天 10:00（台北時區），未付款就重發兩條連結
 * - 只要其中一條付款成功 → 全部標記已付，停止再提醒
 * - 所有 /api* 路由強制回傳 JSON（避免 Unexpected token '<'）
 *********************************************************/

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const cron = require('node-cron');
const { Client } = require('@line/bot-sdk');

// ==== 你的服務模組 (保持原有) ====
const logger = require('./services/logger');
const messageHandler = require('./services/message');
const customerDB = require('./services/customerDatabase');
const googleAuth = require('./services/googleAuth');
const orderManager = require('./services/orderManager');
const { createECPayPaymentLink } = require('./services/openai'); // 綠界付款連結產生器

// ==== 基本設定 ====
const upload = multer({ storage: multer.memoryStorage() });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 強制所有 /api 都回 JSON（避免前端 JSON.parse 讀到 HTML）
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// ==== LINE SDK ====
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ==== Google 私鑰（若存在）====
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    console.log('正在初始化 sheet.json ...');
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('sheet.json 初始化結束');
  } catch (e) {
    console.error('初始化 sheet.json 失敗：', e.message);
  }
} else {
  console.log('跳過 sheet.json 初始化 (使用 OAuth 2.0)');
}

// ========================= 資料檔案（客戶與模板） =========================
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  if (!fs.existsSync(TPL_FILE))  fs.writeFileSync(TPL_FILE, JSON.stringify([
    '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
    '您的衣物已清洗完成，金額 NT$ {amount}，可付款取件',
    '衣物處理中，預付金額 NT$ {amount}',
    '訂金收訖 NT$ {amount}，感謝您的支持！'
  ], null, 2));
}
ensureDataFiles();

function readJSON(fp){ return JSON.parse(fs.readFileSync(fp, 'utf8')); }
function writeJSON(fp, obj){ fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); }

// ========================= 健康檢查 =========================
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ========================= 客戶資料 API =========================
// 取得全部客戶編號
app.get('/api/customer-meta', (_req, res) => {
  try {
    const meta = readJSON(META_FILE);
    res.json({ success: true, ...meta });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 儲存/更新單筆客戶編號 { number?, name, userId }
app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success: false, error: '缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 刪除單筆客戶編號
app.delete('/api/customer-meta/:number', (req, res) => {
  try {
    const no = String(req.params.number);
    const meta = readJSON(META_FILE);
    if (!meta.map[no]) return res.json({ success: false, error: '不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========================= 訊息模板 API =========================
// 取得模板
app.get('/api/templates', (_req, res) => {
  try { res.json({ success: true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 新增模板 { content }
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success: false, error: '缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 更新模板
app.put('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr[idx] = content || arr[idx]; writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 刪除模板
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr.splice(idx, 1); writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ========================= 使用者列表（沿用原本） =========================
async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (error) {
    logger.logError('記錄用戶資料失敗', error, userId);
  }
}
app.get('/api/users', (_req, res) => {
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

// ========================= LINE Pay 設定與工具 =========================
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me' : 'https://api-pay.line.me'
};
function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const requestBody = {
      amount,
      currency: 'TWD',
      orderId,
      packages: [{
        id: orderId,
        amount,
        name: 'C.H精緻洗衣服務',
        products: [{ name: '洗衣服務費用', quantity: 1, price: amount }]
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
      return { success: true, paymentUrl: result.info.paymentUrl.web, orderId, transactionId: result.info.transactionId };
    } else {
      logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
      return { success: false, error: result.returnMessage };
    }
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ========================= LINE Webhook（沿用） =========================
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

// ========================= OAuth/測試/檔案等（沿用） =========================
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
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>授權成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}</style></head><body><div class="container"><h1>✅ 授權成功!</h1><p>Google Sheets 和 Drive 已成功連接</p><p>您可以關閉此視窗了</p></div></body></html>');
  } catch (error) {
    logger.logError('處理授權碼失敗', error);
    res.status(500).send('授權失敗: ' + error.message);
  }
});
app.get('/auth/status', (_req, res) => {
  const isAuthorized = googleAuth.isAuthorized();
  res.json({ authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

// 簡化：略去 /test-sheets /test-upload 等頁面（你可保留）

// ========================= 付款頁（靜態） =========================
app.get('/payment', (req, res) => {
  res.sendFile('payment.html', { root: './public' });
});

// ========================= 綠界支付轉頁（永久有效） =========================
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try {
    const paymentData = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const formHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>跳轉到綠界付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px}.loading{font-size:18px;color:#666}</style></head><body><h3 class="loading">正在跳轉到付款頁面...</h3><p>請稍候,若未自動跳轉請點擊下方按鈕</p><form id="ecpayForm" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">' + Object.keys(paymentData).map(key => `<input type="hidden" name="${key}" value="${paymentData[key]}">`).join('\n') + '<button type="submit" style="padding:10px 20px;font-size:16px;cursor:pointer">前往付款</button></form><script>setTimeout(function(){document.getElementById("ecpayForm").submit()},500)</script></body></html>';
    res.send(formHTML);
  } catch (error) {
    logger.logError('付款跳轉失敗', error);
    res.status(500).send('付款連結錯誤');
  }
});

// 成功/取消頁
app.get('/payment/success', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});
app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

// ========================= 永久入口：/payment/linepay/pay/:orderId =========================
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 訂單不存在</h1><p>找不到此訂單</p></div></body></html>');
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天(168 小時)</p><p>訂單編號: ' + orderId + '</p><p>請聯繫 C.H 精緻洗衣客服重新取得訂單</p></div></body></html>');
  }
  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ' + orderId + '</p></div></body></html>');
  }
  try {
    logger.logToFile(`🔄 重新生成 LINE Pay 連結: ${orderId}`);
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
      res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head><body><div class="container"><h1>💳 前往 LINE Pay 付款</h1><div class="info"><p><strong>訂單編號:</strong> ' + orderId + '</p><p><strong>金額:</strong> NT$ ' + order.amount.toLocaleString() + '</p><p><strong>剩餘有效時間:</strong> ' + remainingHours + ' 小時</p></div><p>⏰ 付款連結 20 分鐘內有效</p><p>若超過時間,請重新點擊此頁即可再次取得新的付款頁面</p><a href="' + linePayResult.paymentUrl + '" class="btn">立即前往 LINE Pay 付款</a></div><script>setTimeout(function(){window.location.href="' + linePayResult.paymentUrl + '"},1200)</script></body></html>');
    } else {
      res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>❌ 付款連結生成失敗</h1><p>' + linePayResult.error + '</p></body></html>');
    }
  } catch (error) {
    logger.logError('重新生成 LINE Pay 連結失敗', error);
    res.status(500).send('系統錯誤');
  }
});

// ========================= LINE Pay 確認（付款後回到此） =========================
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
      headers: { 'Content-Type': 'application/json', 'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId, 'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': signature },
      body: JSON.stringify(requestBody)
    });
    const result = await response.json();
    if (result.returnCode === '0000') {
      if (order) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);

      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, { type: 'text', text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名:${decodeURIComponent(userName)}\n付款金額:NT$ ${parseInt(amount).toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${orderId}\n交易編號:${transactionId}\n\n狀態:✅ 付款成功` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type: 'text', text: `✅ LINE Pay 付款成功\n\n感謝 ${decodeURIComponent(userName)} 的支付\n金額:NT$ ${parseInt(amount).toLocaleString()}\n訂單編號:${orderId}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙` });
      }
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

// ========================= 訂單 API（查詢/續期/清理/提醒） =========================
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  let orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const ordersWithStatus = orders.map(order => ({
    ...order,
    isExpired: orderManager.isExpired(order.orderId),
    remainingTime: Math.max(0, order.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  res.json({ success: true, total: ordersWithStatus.length, orders: ordersWithStatus, statistics: orderManager.getStatistics() });
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
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);

    // 綠界連結（也縮網址）
    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayLink = t2;
    } catch { logger.logToFile(`⚠️ 綠界短網址失敗，使用原網址`); }

    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      const persistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;
      let linepayShort = persistentUrl;
      try {
        const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
        const t1 = await r1.text();
        if (t1 && t1.startsWith('http')) linepayShort = t1;
      } catch { logger.logToFile(`⚠️ LINE Pay 短網址失敗，使用原網址`); }

      await client.pushMessage(order.userId, {
        type: 'text',
        text:
          `🔄 付款連結已重新生成\n\n` +
          `訂單編號: ${orderId}\n` +
          `客戶姓名: ${order.userName}\n` +
          `金額: NT$ ${order.amount.toLocaleString()}\n\n` +
          `— 請選擇付款方式 —\n` +
          `綠界信用卡：\n${ecpayLink}\n\n` +
          `LINE Pay：\n${linepayShort}\n\n` +
          `備註：LINE Pay 官方頁面單次開啟 20 分鐘內有效，過時再回來點同一條即可。\n` +
          `✅ 任一方式付款成功即結案`
      });

      orderManager.markReminderSent(orderId);
      logger.logToFile(`✅ 單筆續約重發（綠界+LINE Pay）：${orderId}`);
      return res.json({
        success: true,
        message: '訂單已續約並重新發送付款連結（含綠界 + LINE Pay）',
        order,
        links: { ecpay: ecpayLink, linepay: linepayShort }
      });
    } else {
      logger.logToFile(`❌ LINE Pay 付款請求失敗（續約重發）: ${orderId}`);
      return res.status(500).json({ success: false, error: '重新生成 LINE Pay 連結失敗' });
    }
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

// 手動觸發提醒（批次）
app.post('/api/orders/send-reminders', async (_req, res) => {
  const sent = await sendRemindersBatch();
  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent });
});

// 統計／清理
app.get('/api/orders/statistics', (_req, res) => {
  res.json({ success: true, statistics: orderManager.getStatistics() });
});
app.post('/api/orders/clean-expired', (_req, res) => {
  const cleaned = orderManager.cleanExpiredOrders();
  res.json({ success: true, message: `已清理 ${cleaned} 筆過期訂單`, cleaned });
});

// ========================= 發送付款（同時支援 綠界 / LINE Pay / 兩者） =========================
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);
  if (!userId || !userName || !amount) {
    return res.status(400).json({ error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }
  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: '金額必須是正整數' });
  }

  try {
    const type = paymentType || 'both';
    let ecpayLink = '';
    let linepayLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    // 綠界
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      ecpayLink = createECPayPaymentLink(userId, userName, numAmount);
      try {
        const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
        const t = await r.text();
        if (t && t.startsWith('http')) ecpayLink = t;
      } catch { logger.logToFile('⚠️ 綠界短網址失敗，使用原址'); }
    }

    // LINE Pay
    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);
      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;
        orderManager.createOrder(linePayResult.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        const persistentUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app'}/payment/linepay/pay/${linePayResult.orderId}`;
        linepayLink = persistentUrl;
        try {
          const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
          const t = await r.text();
          if (t && t.startsWith('http')) linepayLink = t;
        } catch { logger.logToFile('⚠️ LINE Pay 短網址失敗，使用原址'); }
      } else {
        logger.logToFile('❌ LINE Pay 付款請求失敗');
      }
    }

    // 組訊息（中文字樣）
    const msg = customMessage || '';
    let finalMessage = '';
    if (type === 'both' && ecpayLink && linepayLink) {
      finalMessage = msg
        ? `${msg}\n\n綠界信用卡：\n${ecpayLink}\n\nLINE Pay：\n${linepayLink}\n\n✅ 任一方式付款成功即結案`
        : `💙 您好，${userName}\n金額：NT$ ${numAmount.toLocaleString()}\n\n綠界信用卡：\n${ecpayLink}\n\nLINE Pay：\n${linepayLink}\n\n✅ 任一方式付款成功即結案`;
    } else if (type === 'ecpay' && ecpayLink) {
      finalMessage = msg
        ? `${msg}\n\n綠界信用卡：\n${ecpayLink}\n\n✅ 付款完成後系統會自動通知我們`
        : `💙 您好，${userName}\n金額：NT$ ${numAmount.toLocaleString()}\n\n綠界信用卡：\n${ecpayLink}\n\n✅ 付款完成後系統會自動通知我們`;
    } else if (type === 'linepay' && linepayLink) {
      finalMessage = msg
        ? `${msg}\n\nLINE Pay：\n${linepayLink}\n\n✅ 付款完成後系統會自動通知我們`
        : `💙 您好，${userName}\n金額：NT$ ${numAmount.toLocaleString()}\n\nLINE Pay：\n${linepayLink}\n\n✅ 付款完成後系統會自動通知我們`;
    } else {
      return res.status(500).json({ error: '付款連結生成失敗' });
    }

    await client.pushMessage(userId, { type: 'text', text: finalMessage });
    logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount}元 (${type})`);
    res.json({
      success: true,
      message: '付款連結已發送',
      data: {
        userId, userName, amount: numAmount, paymentType: type,
        ecpayLink: ecpayLink || null, linepayLink: linepayLink || null,
        ecpayOrderId: ecpayOrderId || null, linePayOrderId: linePayOrderId || null,
        customMessage: msg
      }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '發送失敗', details: err.message });
  }
});

// ========================= 綠界回調（付款成功→全部標記已付） =========================
app.post('/payment/ecpay/callback', async (req, res) => {
  try {
    logger.logToFile(`收到綠界回調: ${JSON.stringify(req.body)}`);
    const { MerchantTradeNo, RtnCode, RtnMsg, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body;
    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付'); // ✅ 任何待付單全結案
      logger.logToFile(`✅ 綠界付款成功,已標記 ${updated} 筆訂單為已付款`);

      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, { type: 'text', text: `🎉 收到綠界付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${amount.toLocaleString()}\n付款方式: ${getPaymentTypeName(PaymentType)}\n付款時間: ${PaymentDate}\n綠界訂單: ${MerchantTradeNo}\n\n狀態: ✅ 付款成功` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type: 'text', text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${amount.toLocaleString()}\n綠界訂單: ${MerchantTradeNo}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙` });
      }
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
  const types = { 'Credit_CreditCard': '信用卡', 'ATM_LAND': 'ATM 轉帳', 'CVS_CVS': '超商代碼', 'BARCODE_BARCODE': '超商條碼', 'WebATM_TAISHIN': '網路 ATM' };
  return types[code] || code;
}

// ========================= 批次提醒實作（給 API 與排程共用） =========================
async function sendRemindersBatch() {
  const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
  if (ordersNeedingReminder.length === 0) return 0;

  let sent = 0;
  const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

  for (const order of ordersNeedingReminder) {
    try {
      const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (linePayResult.success) {
        // 新建持久入口訂單、刪舊單（保持你原本的統計邏輯）
        orderManager.createOrder(linePayResult.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        orderManager.deleteOrder(order.orderId);

        const persistentUrl = `${baseURL}/payment/linepay/pay/${linePayResult.orderId}`;
        let linepayShort = persistentUrl;
        try {
          const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
          const result = await response.text();
          if (result && result.startsWith('http')) linepayShort = result;
        } catch { logger.logToFile(`⚠️ LINE Pay 短網址生成失敗,使用原網址`); }

        // 綠界
        let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
        try {
          const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
          const t2 = await r2.text();
          if (t2 && t2.startsWith('http')) ecpayLink = t2;
        } catch { logger.logToFile(`⚠️ 綠界短網址失敗，使用原網址`); }

        await client.pushMessage(order.userId, {
          type: 'text',
          text:
            `😊 自動付款提醒\n\n` +
            `親愛的 ${order.userName} 您好，此次洗衣服務尚未付款\n` +
            `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
            `綠界信用卡：\n${ecpayLink}\n\n` +
            `LINE Pay：\n${linepayShort}\n\n` +
            `✅ 任一方式付款成功就不會再提醒您囉！`
        });

        sent++;
        orderManager.markReminderSent(linePayResult.orderId);
        logger.logToFile(`✅ 已發送付款提醒（綠界+LINE Pay）：${order.orderId} -> ${linePayResult.orderId}`);
      } else {
        logger.logToFile(`❌ 重新生成付款連結失敗: ${order.orderId}`);
      }
    } catch (error) {
      logger.logError(`發送提醒失敗: ${order.orderId}`, error);
    }
  }
  return sent;
}

// ========================= 自動排程：每 2 天 10:00（台北） =========================
cron.schedule('0 10 */2 * *', async () => {
  try {
    const cnt = await sendRemindersBatch();
    logger.logToFile(`⏰ 自動提醒完成，共發送 ${cnt} 筆`);
  } catch (e) {
    logger.logError('⏰ 自動提醒排程錯誤', e);
  }
}, { timezone: 'Asia/Taipei' });

// ========================= 啟動 =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器正在運行, 端口: ${PORT}`);
  logger.logToFile(`伺服器正在運行,端口:${PORT}`);
  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (error) {
    console.error('❌ 客戶資料載入失敗:', error.message);
  }
  // 每日清過期
  setInterval(() => { orderManager.cleanExpiredOrders(); }, 24 * 60 * 60 * 1000);
});