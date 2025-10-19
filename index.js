/** =======================
 *  C.H 精緻洗衣 – 主程式
 *  ======================= */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cron = require('node-cron');

const { Client } = require('@line/bot-sdk');

const logger = require('./services/logger');
const messageHandler = require('./services/message');
const googleAuth = require('./services/googleAuth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const customerDB = require('./services/customerDatabase');
const orderManager = require('./services/orderManager');
const { createECPayPaymentLink } = require('./services/openai'); // 綠界付款連結產生器

// ------------------ Google 憑證（與你原本一致） ------------------
if (process.env.GOOGLE_PRIVATE_KEY) {
  console.log(`正在初始化 sheet.json: 成功`);
  fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
  console.log(`sheet.json 初始化结束`);
} else {
  console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

// ------------------ App 基本設定 ------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 健康檢查
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ------------------ LINE SDK ------------------
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

// ------------------ 「客戶編號＋模板」檔案層 ------------------
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
function json(res, obj, code=200){ res.status(code).type('application/json').send(JSON.stringify(obj)); }

// 雙掛載：同時支援 /api/* 與 /* 以避免前端打錯路徑時回文字 404
const paths = {
  getMeta:  ['/api/customer-meta','/customer-meta'],
  saveMeta: ['/api/customer-meta/save','/customer-meta/save'],
  delMeta:  ['/api/customer-meta/:number','/customer-meta/:number'],
  getTpl:   ['/api/templates','/templates'],
  addTpl:   ['/api/templates','/templates'],
  putTpl:   ['/api/templates/:index','/templates/:index'],
  delTpl:   ['/api/templates/:index','/templates/:index'],
};

// 取得全部客戶編號（含 nextNo 與 map）
app.get(paths.getMeta, (_req, res) => {
  try { json(res, { success:true, ...readJSON(META_FILE) }); }
  catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 儲存/更新單筆客戶編號 { number?, name, userId }
app.post(paths.saveMeta, (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return json(res, { success:false, error:'缺少 name 或 userId' });
    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    json(res, { success:true, number:no, data:meta.map[no] });
  } catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 刪除單筆客戶編號
app.delete(paths.delMeta, (req, res) => {
  try {
    const no = String(req.params.number);
    const meta = readJSON(META_FILE);
    if (!meta.map[no]) return json(res, { success:false, error:'不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    json(res, { success:true });
  } catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 取得全部模板
app.get(paths.getTpl, (_req, res) => {
  try { json(res, { success:true, templates: readJSON(TPL_FILE) }); }
  catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 新增模板 { content }
app.post(paths.addTpl, (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return json(res, { success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    json(res, { success:true, templates: arr });
  } catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 更新模板
app.put(paths.putTpl, (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >=0 && idx < arr.length)) return json(res, { success:false, error:'索引錯誤' });
    arr[idx] = content || arr[idx]; writeJSON(TPL_FILE, arr);
    json(res, { success:true, templates: arr });
  } catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// 刪除模板
app.delete(paths.delTpl, (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >=0 && idx < arr.length)) return json(res, { success:false, error:'索引錯誤' });
    arr.splice(idx,1); writeJSON(TPL_FILE, arr);
    json(res, { success:true, templates: arr });
  } catch (e) { json(res, { success:false, error:e.message }, 500); }
});

// ------------------ 你原本的 Users API（保留） ------------------
app.get('/api/users', (_req, res) => {
  const users = customerDB.getAllCustomers();
  json(res, { total: users.length, users });
});

app.get('/api/user/:userId', (req, res) => {
  const user = customerDB.getCustomer(req.params.userId);
  if (user) json(res, user);
  else json(res, { error:'找不到此用戶' }, 404);
});

app.put('/api/user/:userId/name', express.json(), async (req, res) => {
  const { userId } = req.params;
  const { displayName } = req.body;
  if (!displayName || displayName.trim() === '') {
    return json(res, { error:'名稱不能為空' }, 400);
  }
  try {
    const user = await customerDB.updateCustomerName(userId, displayName.trim());
    json(res, { success:true, message:'名稱已更新', user });
  } catch (error) {
    json(res, { error: error.message }, 500);
  }
});

app.get('/api/search/user', (req, res) => {
  const { name } = req.query;
  if (!name) return json(res, { error:'請提供搜尋名稱' }, 400);
  const results = customerDB.searchCustomers(name);
  json(res, { total: results.length, users: results });
});

// ------------------ LINE Pay 設定與函式 ------------------
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
        id: orderId, amount: amount, name: 'C.H精緻洗衣服務',
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

// ------------------ LINE Webhook（保留） ------------------
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
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

// ------------------ Google OAuth（保留） ------------------
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
  json(res, { authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

// ------------------ 付款相關頁面 & 路由 ------------------

// 綠界跳轉頁（form 自動提交）
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

app.get('/payment/success', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});

app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

// LINE Pay「持久入口」（不會過期；每次點開都重新要 20 分鐘官方頁）
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
      res.redirect(linePayResult.paymentUrl); // 直接帶去 LINE Pay 官方頁
    } else {
      res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>❌ 付款連結生成失敗</h1><p>' + linePayResult.error + '</p></body></html>');
    }
  } catch (error) {
    logger.logError('重新生成 LINE Pay 連結失敗', error);
    res.status(500).send('系統錯誤');
  }
});

// LINE Pay 確認
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
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay'); // 任一管道付款，一併結案
      logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);
      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, {
          type: 'text',
          text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名:${decodeURIComponent(userName)}\n付款金額:NT$ ${parseInt(amount).toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${orderId}\n交易編號:${transactionId}\n\n狀態:✅ 付款成功`
        });
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

// ------------------ 訂單 API（保留） ------------------
app.get('/api/orders', (_req, res) => {
  let orders = orderManager.getAllOrders();
  const ordersWithStatus = orders.map(order => ({
    ...order,
    isExpired: orderManager.isExpired(order.orderId),
    remainingTime: Math.max(0, order.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  json(res, { success: true, total: ordersWithStatus.length, orders: ordersWithStatus, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const order = orderManager.getOrder(req.params.orderId);
  if (order) {
    json(res, { success: true, order: {
      ...order,
      isExpired: orderManager.isExpired(order.orderId),
      remainingTime: Math.max(0, order.expiryTime - Date.now()),
      remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
    }});
  } else {
    json(res, { success:false, error:'找不到此訂單' }, 404);
  }
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return json(res, { success:false, error:'找不到此訂單' }, 404);

  try {
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);

    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    // 中文標籤，不做短網址，避免被攔截：在訊息中就用「綠界信用卡」「LINE Pay」為超連結
    const persistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

      const msg =
        `🔄 付款連結已重新生成\n\n` +
        `訂單編號: ${orderId}\n` +
        `客戶姓名: ${order.userName}\n` +
        `金額: NT$ ${order.amount.toLocaleString()}\n\n` +
        `— 請選擇付款方式 —\n` +
        `綠界信用卡：${ecpayLink}\n` +
        `LINE Pay：${persistentUrl}\n\n` +
        `備註：LINE Pay 官方頁面每次開啟 20 分鐘有效；過時再回來點同一條（不會失效）。\n` +
        `✅ 付款後系統會自動通知我們`;
      await client.pushMessage(order.userId, { type:'text', text: msg });

      orderManager.markReminderSent(orderId);
      logger.logToFile(`✅ 單筆續約重發（綠界+LINE Pay）：${orderId}`);
      return json(res, { success:true, message:'訂單已續約並重新發送付款連結（含綠界 + LINE Pay）', order,
        links:{ ecpay: ecpayLink, linepay: persistentUrl } });
    } else {
      logger.logToFile(`❌ LINE Pay 付款請求失敗（續約重發）: ${orderId}`);
      return json(res, { success:false, error:'重新生成 LINE Pay 連結失敗' }, 500);
    }
  } catch (error) {
    logger.logError('續約訂單失敗', error);
    return json(res, { success:false, error: error.message }, 500);
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const deleted = orderManager.deleteOrder(req.params.orderId);
  if (deleted) json(res, { success:true, message:'訂單已刪除' });
  else json(res, { success:false, error:'找不到此訂單' }, 404);
});

app.post('/api/orders/statistics', (_req, res) => {
  json(res, { success:true, statistics: orderManager.getStatistics() });
});

// 兩天提醒一次 – 使用 cron（每日 09:15 檢查，符合者就推送）
cron.schedule('15 9 * * *', async () => {
  try {
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
    for (const order of ordersNeedingReminder) {
      try {
        const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (linePayResult.success) {
          // 建新單、刪舊單（保留你原本行為）
          orderManager.createOrder(linePayResult.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
          orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
          orderManager.deleteOrder(order.orderId);

          const persistentUrl = `${baseURL}/payment/linepay/pay/${linePayResult.orderId}`;
          const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);

          const msg =
            `😊 自動付款提醒\n\n` +
            `親愛的 ${order.userName} 您好，您於本次洗衣服務仍待付款\n` +
            `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
            `綠界信用卡：${ecpayLink}\n` +
            `LINE Pay：${persistentUrl}\n\n` +
            `備註：LINE Pay 官方頁面每次開啟 20 分鐘有效；過時再回來點同一條（不會失效）。`;
          await client.pushMessage(order.userId, { type:'text', text: msg });

          orderManager.markReminderSent(linePayResult.orderId);
          logger.logToFile(`✅ 自動發送付款提醒（綠界+LINE Pay）：${order.orderId} -> ${linePayResult.orderId}`);
        } else {
          logger.logToFile(`❌ 自動提醒失敗,無法生成付款連結: ${order.orderId}`);
        }
      } catch (error) {
        logger.logError(`自動提醒失敗: ${order.orderId}`, error);
      }
    }
  } catch (e) {
    logger.logError('自動提醒排程錯誤', e);
  }
}, { timezone: 'Asia/Taipei' });

// ------------------ 一鍵發送付款（保留並美化訊息） ------------------
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);
  if (!userId || !userName || !amount) {
    return json(res, { error:'缺少必要參數', required:['userId','userName','amount'] }, 400);
  }

  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return json(res, { error:'金額必須是正整數' }, 400);
  }

  try {
    const type = paymentType || 'both';
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

    let ecpayLink = '';
    let linepayEntry = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      ecpayLink = createECPayPaymentLink(userId, userName, numAmount);
    }

    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);
      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;
        orderManager.createOrder(linePayResult.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        linepayEntry = `${baseURL}/payment/linepay/pay/${linePayResult.orderId}`; // 持久入口
      } else {
        logger.logToFile(`❌ LINE Pay 付款請求失敗`);
      }
    }

    // 組訊息（中文標籤）
    let finalMessage = '';
    const userMsg = customMessage ? `${customMessage}\n\n` : '';
    if (type === 'both' && ecpayLink && linepayEntry) {
      finalMessage =
        `${userMsg}金額：NT$ ${numAmount.toLocaleString()}\n\n` +
        `【綠界信用卡】\n${ecpayLink}\n\n` +
        `【LINE Pay】\n${linepayEntry}\n\n` +
        `✅ 付款後系統會自動通知我們`;
    } else if (type === 'ecpay' && ecpayLink) {
      finalMessage =
        `${userMsg}付款方式：綠界信用卡\n金額：NT$ ${numAmount.toLocaleString()}\n\n` +
        `${ecpayLink}\n\n✅ 付款後系統會自動通知我們`;
    } else if (type === 'linepay' && linepayEntry) {
      finalMessage =
        `${userMsg}付款方式：LINE Pay\n金額：NT$ ${numAmount.toLocaleString()}\n\n` +
        `${linepayEntry}\n\n✅ 付款後系統會自動通知我們`;
    } else {
      return json(res, { error:'付款連結生成失敗' }, 500);
    }

    await client.pushMessage(userId, { type:'text', text: finalMessage });
    logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount}元 (${type})`);

    json(res, { success:true, message:'付款連結已發送',
      data: { userId, userName, amount:numAmount, paymentType:type,
        ecpayLink: ecpayLink || null, linepayLink: linepayEntry || null,
        ecpayOrderId: ecpayOrderId || null, linePayOrderId: linePayOrderId || null, customMessage: customMessage || '' } });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    json(res, { error:'發送失敗', details: err.message }, 500);
  }
});

// 綠界 callback（任一成功都關閉所有 pending）
app.post('/payment/ecpay/callback', async (req, res) => {
  try {
    logger.logToFile(`收到綠界回調: ${JSON.stringify(req.body)}`);
    const { MerchantTradeNo, RtnCode, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body;
    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付'); // 任一管道付成功就結案
      logger.logToFile(`✅ 綠界付款成功,已標記 ${updated} 筆訂單為已付款`);
      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, { type:'text',
          text: `🎉 收到綠界付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${amount.toLocaleString()}\n付款方式: ${getPaymentTypeName(PaymentType)}\n付款時間: ${PaymentDate}\n綠界訂單: ${MerchantTradeNo}\n\n狀態: ✅ 付款成功` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type:'text',
          text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${amount.toLocaleString()}\n綠界訂單: ${MerchantTradeNo}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙` });
      }
    } else {
      logger.logToFile(`❌ 綠界付款異常`);
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

// 管理頁
app.get('/payment', (_req, res) => {
  res.sendFile('payment.html', { root: './public' });
});

// 其它工具頁（保留）
app.get('/test-upload', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試上傳</title></head><body><h1>測試上傳功能已停用</h1></body></html>');
});
app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return json(res, { success:false, error:'沒有收到圖片' }, 400);
    const type = req.body.type || 'before';
    const { customerLogService } = require('./services/multiSheets');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const typeLabel = type === 'after' ? '洗後' : '洗前';
    const filename = `${typeLabel}_test_${timestamp}.jpg`;
    const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
    if (result.success) {
      logger.logToFile(`✅ ${typeLabel}測試上傳成功: ${filename}`);
      json(res, { success:true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    } else {
      json(res, { success:false, error: result.error }, 500);
    }
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    json(res, { success:false, error: error.message }, 500);
  }
});

app.get('/log', (_req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

app.get('/test-push', async (_req, res) => {
  const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx";
  try {
    await client.pushMessage(userId, { type:'text', text:'✅ 測試推播成功! 這是一則主動訊息 🚀' });
    res.send("推播成功,請查看 LINE Bot 訊息");
  } catch (err) {
    console.error("推播錯誤", err);
    res.status(500).send(`推播失敗: ${err.message}`);
  }
});

// ------------------ 啟動 ------------------
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
});