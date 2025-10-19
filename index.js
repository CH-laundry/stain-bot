// ====================== index.js (drop-in replacement) ======================
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const fetch = require('node-fetch');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const { Client } = require('@line/bot-sdk');

const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
const customerDB = require('./services/customerDatabase');
const googleAuth = require('./services/googleAuth');

// 你原本的：綠界付款資料產生器（回傳的是我們自己 /payment/redirect 的 URL）
const { createECPayPaymentLink } = require('./services/openai');

// ---------- 基本設定 ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));   // 提供 /payment.html

// ---------- LINE SDK ----------
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ---------- 寫入 sheet.json（舊機制），沒有就略過 ----------
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('sheet.json 初始化完成');
  } catch (e) {
    console.log('sheet.json 初始化失敗：', e.message);
  }
}

// ======================================================
// A. 後端永久儲存：客戶編號 + 訊息模板（讓前端手機/電腦都同步）
// ======================================================
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  }
  if (!fs.existsSync(TPL_FILE)) {
    fs.writeFileSync(TPL_FILE, JSON.stringify([
      '您好,已收回衣物,金額 NT$ {amount},請儘速付款,謝謝!',
      '您的衣物已清洗完成,金額 NT$ {amount},可付款取件',
      '衣物處理中,預付金額 NT$ {amount}',
      '訂金收訖 NT$ {amount},感謝您的支持!'
    ], null, 2));
  }
}
function readJSON(fp){ return JSON.parse(fs.readFileSync(fp, 'utf8')); }
function writeJSON(fp, obj){ fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); }

ensureDataFiles();

// 取得全部客戶編號
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success:true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 儲存/更新單筆客戶編號 { number?, name, userId }
app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success:false, error:'缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    let no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success:true, number:no, data:meta.map[no] });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// 刪除單筆客戶編號
app.delete('/api/customer-meta/:number', (req, res) => {
  try {
    const no = String(req.params.number);
    const meta = readJSON(META_FILE);
    if (!meta.map[no]) return res.json({ success:false, error:'不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    res.json({ success:true });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// 取得模板
app.get('/api/templates', (_req, res) => {
  try { res.json({ success:true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 新增模板 { content }
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 更新模板
app.put('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >=0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr[idx] = content || arr[idx]; writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 刪除模板
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >=0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(idx,1); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// ======================================================
// B. 使用者/搜尋 API（沿用你原本的）
// ======================================================
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
  if (!name) return res.status(400).json({ error:'請提供搜尋名稱' });
  const results = customerDB.searchCustomers(name);
  res.json({ total: results.length, users: results });
});

// ======================================================
// C. LINE Pay 設定與方法
// ======================================================
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

// 依目前金額「即時」生成一張 20 分鐘有效的 LINE Pay 票
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || `https://${process.env.RAILWAY_STATIC_URL || ''}` || '';
    const host = baseURL || '';

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
        confirmUrl: `${host}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl: `${host}/payment/linepay/cancel`
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
    }
    logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
    return { success: false, error: result.returnMessage };
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ======================================================
// D. Webhook（簡化，保留能動）
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== 'message' || !event.source?.userId) continue;
      const userId = event.source.userId;
      await saveUserProfile(userId);
      // 這裡省略回覆邏輯（你原本的 messageHandler），不影響付款功能
    }
  } catch (err) {
    logger.logError('Webhook 錯誤', err);
  }
});

// ======================================================
// E. 永久入口（IMPORTANT）
// 1) LINE Pay 入口：每次即時取票，然後 redirect 到官方支付頁
app.get('/pay/line/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');
  if (orderManager.isExpired(orderId)) return res.status(410).send('此訂單已過期，請向店家索取新連結');
  try {
    const r = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!r.success) return res.status(500).send('LINE Pay 重新產生失敗');
    orderManager.updatePaymentInfo(orderId, r.transactionId, r.paymentUrl);
    return res.redirect(r.paymentUrl);
  } catch (e) {
    logger.logError('pay/line 失敗', e);
    return res.status(500).send('系統錯誤');
  }
});

// 2) 綠界入口：每次即時產生我們 /payment/redirect 的網址，再 redirect
app.get('/pay/ec/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');
  if (orderManager.isExpired(orderId)) return res.status(410).send('此訂單已過期，請向店家索取新連結');
  try {
    const link = createECPayPaymentLink(order.userId, order.userName, order.amount);
    return res.redirect(link); // link 會落到 /payment/redirect → 自動送出到綠界
  } catch (e) {
    logger.logError('pay/ec 失敗', e);
    res.status(500).send('產生綠界入口失敗');
  }
});

// ======================================================
// F. 付款頁輔助（沿用你原本的）
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

app.get('/payment/success', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});

app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

// LINE Pay 付款確認（沿用）
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);
  if (order && orderManager.isExpired(orderId)) {
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

// ======================================================
// G. 訂單 API（列表、續約、刪除、提醒…）
app.get('/api/orders', (_req, res) => {
  const orders = orderManager.getAllOrders();
  const ordersWithStatus = orders.map(order => ({
    ...order,
    isExpired: orderManager.isExpired(order.orderId),
    remainingTime: Math.max(0, order.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  res.json({ success:true, total: ordersWithStatus.length, orders: ordersWithStatus, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const order = orderManager.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({
    success:true,
    order: {
      ...order,
      isExpired: orderManager.isExpired(order.orderId),
      remainingTime: Math.max(0, order.expiryTime - Date.now()),
      remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
    }
  });
});

// 續約：保留同一編號（入口一樣），並發送兩顆按鈕
app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  const base = process.env.RAILWAY_PUBLIC_DOMAIN || `https://${req.headers.host}`;
  const ecEntry   = `${base}/pay/ec/${orderId}`;
  const lineEntry = `${base}/pay/line/${orderId}`;

  try {
    const bubbles = buildPayFlex(order.userName, order.amount, ecEntry, lineEntry, '重新為您生成付款連結');
    await client.pushMessage(order.userId, bubbles);
    orderManager.markReminderSent(orderId);
    logger.logToFile(`✅ 續約並重發付款連結：${orderId}`);
    res.json({ success:true, message:'已續約並重新發送付款連結', order, links:{ ecpay: ecEntry, linepay: lineEntry } });
  } catch (e) {
    logger.logError('續約發送失敗', e);
    res.status(500).json({ success:false, error:'推播失敗' });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (!ok) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({ success:true, message:'訂單已刪除' });
});

// 群發提醒（每 2 天），使用永久入口兩顆按鈕
app.post('/api/orders/send-reminders', async (_req, res) => {
  const list = orderManager.getOrdersNeedingReminder();
  if (list.length === 0) return res.json({ success:true, message:'目前沒有需要提醒的訂單', sent:0 });
  let sent = 0;

  for (const order of list) {
    try {
      const base = process.env.RAILWAY_PUBLIC_DOMAIN || '';
      const ecEntry   = `${base}/pay/ec/${order.orderId}`;
      const lineEntry = `${base}/pay/line/${order.orderId}`;
      const bubbles = buildPayFlex(order.userName, order.amount, ecEntry, lineEntry, '付款提醒：請點任一按鈕完成付款');
      await client.pushMessage(order.userId, bubbles);
      orderManager.markReminderSent(order.orderId);
      sent++;
    } catch (e) {
      logger.logError('發送提醒失敗', e, order.orderId);
    }
  }
  res.json({ success:true, message:`已發送 ${sent} 筆付款提醒`, sent });
});

app.get('/api/orders/statistics', (_req, res) => {
  res.json({ success:true, statistics: orderManager.getStatistics() });
});

app.post('/api/orders/clean-expired', (_req, res) => {
  const cleaned = orderManager.cleanExpiredOrders();
  res.json({ success:true, message:`已清理 ${cleaned} 筆過期訂單`, cleaned });
});

// ======================================================
// H. 送出付款：支援 /send-payment 與 /api/send-payment（避免舊前端 404）
function buildPayFlex(userName, amount, ecUrl, lineUrl, customText) {
  const title = `付款連結（${Number(amount).toLocaleString()} 元）`;
  const bodyText = customText && customText.trim()
    ? customText.trim()
    : `您好，${userName}\n請點以下任一方式完成付款`;
  return {
    type: "flex",
    altText: `付款連結：${amount} 元`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: title, weight: "bold", size: "lg" },
          { type: "text", text: bodyText, wrap: true, margin: "md", size: "sm", color: "#666666" },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "md",
            contents: [
              { type: "button", style: "primary",   action: { type: "uri", label: "綠界信用卡", uri: ecUrl } },
              { type: "button", style: "secondary", action: { type: "uri", label: "LINE Pay",  uri: lineUrl } }
            ]
          }
        ]
      }
    }
  };
}

async function handleSendPayment(req, res) {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) return res.status(400).json({ success:false, error:'缺少必要參數 userId/userName/amount' });
    const amt = parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ success:false, error:'金額必須為正整數' });

    // 建立主訂單（作為永久入口標識）
    const orderId = `ORD${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    orderManager.createOrder(orderId, { userId, userName, amount: amt });

    const base = process.env.RAILWAY_PUBLIC_DOMAIN || `https://${req.headers.host}`;
    const ecEntry   = `${base}/pay/ec/${orderId}`;
    const lineEntry = `${base}/pay/line/${orderId}`;

    const bubbles = buildPayFlex(userName, amt, ecEntry, lineEntry, customMessage);
    await client.pushMessage(userId, bubbles);

    logger.logToFile(`✅ 已發送 Flex 付款連結：${userName} - ${amt}元 (${paymentType || 'both'})`);
    res.json({ success:true, orderId, links:{ ecpay: ecEntry, linepay: lineEntry } });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ success:false, error:'發送失敗' });
  }
}
app.post(['/send-payment','/api/send-payment'], handleSendPayment);

// ======================================================
// I. 其它頁面/工具（保持）
app.get('/payment', (_req, res) => {
  res.sendFile('payment.html', { root: './public' });
});

// 簡易檔案上傳測試（保留）
app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, error:'沒有收到圖片' });
    const type = req.body.type || 'before';
    const { customerLogService } = require('./services/multiSheets');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${type === 'after' ? '洗後' : '洗前'}_test_${timestamp}.jpg`;
    const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
    if (result.success) res.json({ success:true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    else res.status(500).json({ success:false, error: result.error });
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    res.status(500).json({ success:false, error:error.message });
  }
});

// ======================================================
// J. 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  logger.logToFile(`Server on :${PORT}`);

  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (e) {
    console.error('❌ 客戶資料載入失敗:', e.message);
  }

  // 每天清過期
  setInterval(() => orderManager.cleanExpiredOrders(), 24 * 60 * 60 * 1000);

  // 每 12 小時自動提醒（使用永久入口）
  setInterval(async () => {
    const list = orderManager.getOrdersNeedingReminder();
    for (const order of list) {
      try {
        const base = process.env.RAILWAY_PUBLIC_DOMAIN || '';
        const ecEntry   = `${base}/pay/ec/${order.orderId}`;
        const lineEntry = `${base}/pay/line/${order.orderId}`;
        const bubbles = buildPayFlex(order.userName, order.amount, ecEntry, lineEntry, '付款提醒：請點任一按鈕完成付款');
        await client.pushMessage(order.userId, bubbles);
        orderManager.markReminderSent(order.orderId);
        logger.logToFile(`✅ 自動付款提醒：${order.orderId}`);
      } catch (e) {
        logger.logError('自動提醒失敗', e, order.orderId);
      }
    }
  }, 12 * 60 * 60 * 1000);
});
// ====================== end index.js ======================