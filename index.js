// index.js －－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－
/* 必要套件 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
require('dotenv').config();
const { Client } = require('@line/bot-sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

/* 內部服務 */
const logger = require('./services/logger');
const messageHandler = require('./services/message');
const customerDB = require('./services/customerDatabase');
const orderManager = require('./services/orderManager'); // 你提供的那份，保持不變
const googleAuth = require('./services/googleAuth');
const { createECPayPaymentLink } = require('./services/openai'); // 產生綠界付款連結

/* 基本 App 與中介層 */
const app = express();
app.use(cors());
app.use(express.json());                   // 保證 /api 路由都是 JSON！
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* 健康檢查 & 根目錄 */
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'laundry-bot', time: new Date().toISOString() }));

/* LINE SDK */
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

/* 初始化 sheet.json（如有提供） */
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('正在初始化 sheet.json: 成功');
  } catch (e) {
    console.log('初始化 sheet.json 失敗:', e.message);
  }
}

/* ====== 檔案型儲存：客戶編號 + 訊息模板 ====== */
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

function ensureDataFiles () {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2), 'utf8');
  }
  if (!fs.existsSync(TPL_FILE)) {
    fs.writeFileSync(
      TPL_FILE,
      JSON.stringify([
        '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
        '您的衣物已清洗完成，金額 NT$ {amount}，可付款取件',
        '衣物處理中，預付金額 NT$ {amount}',
        '訂金收訖 NT$ {amount}，感謝您的支持！'
      ], null, 2),
      'utf8'
    );
  }
}
ensureDataFiles();

const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8');

/* ====== Customer Meta API ====== */
// 取得全部客戶編號 { nextNo, map:{ [number]: {name, userId} } }
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 儲存或更新單筆 { number?, name, userId }
app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.status(400).json({ success: false, error: '缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 刪除單筆
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

/* ====== Templates API ====== */
app.get('/api/templates', (_req, res) => {
  try { res.json({ success: true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ success: false, error: '缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
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
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr.splice(idx, 1); writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ====== 你原本的使用者 / 訂單 API（保持） ====== */
app.get('/api/users', (_req, res) => {
  const users = customerDB.getAllCustomers();
  res.json({ total: users.length, users });
});
app.get('/api/user/:userId', (req, res) => {
  const user = customerDB.getCustomer(req.params.userId);
  if (user) res.json(user);
  else res.status(404).json({ error: '找不到此用戶' });
});
app.put('/api/user/:userId/name', async (req, res) => {
  const { userId } = req.params;
  const { displayName } = req.body || {};
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: '名稱不能為空' });
  try {
    const user = await customerDB.updateCustomerName(userId, displayName.trim());
    res.json({ success: true, message: '名稱已更新', user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/search/user', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: '請提供搜尋名稱' });
  const results = customerDB.searchCustomers(name);
  res.json({ total: results.length, users: results });
});

/* ====== LINE Pay 設定 ====== */
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};
const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-2593.up.railway.app';

function linePaySig(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const requestBody = {
      amount, currency: 'TWD', orderId,
      packages: [{ id: orderId, amount, name: 'C.H精緻洗衣服務', products: [{ name: '洗衣服務費用', quantity: 1, price: amount }] }],
      redirectUrls: {
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel`
      }
    };
    const uri = '/v3/payments/request';
    const signature = linePaySig(uri, requestBody, nonce);
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

/* ====== Webhook（保留你的行為） ====== */
async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (e) {
    logger.logError('記錄用戶資料失敗', e, userId);
  }
}
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
          const text = event.message.text.trim();
          logger.logUserMessage(userId, text);
          await messageHandler.handleTextMessage(userId, text, text);
        } else if (event.message.type === 'image') {
          logger.logUserMessage(userId, '上傳了一張圖片');
          await messageHandler.handleImageMessage(userId, event.message.id);
        }
      } catch (err) {
        logger.logError('處理事件時出錯', err, event.source?.userId);
      }
    }
  } catch (err) {
    logger.logError('全局錯誤', err);
  }
});

/* ====== 發送付款（新增 Flex 兩顆中文按鈕） ====== */
async function pushFlexPayment(userId, userName, amount, ecpayUrl, linePayUrl) {
  const bubble = {
    type: 'flex',
    altText: `付款連結 (${userName})`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: '付款通知', weight: 'bold', size: 'lg' }]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `客戶：${userName}`, size: 'md' },
          { type: 'text', text: `金額：NT$ ${amount.toLocaleString()}`, size: 'md' },
          { type: 'separator', margin: 'md' },
          {
            type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md',
            contents: [
              {
                type: 'button', style: 'primary',
                action: { type: 'uri', label: '綠界信用卡', uri: ecpayUrl }
              },
              {
                type: 'button', style: 'secondary',
                action: { type: 'uri', label: 'LINE Pay', uri: linePayUrl }
              }
            ]
          },
          { type: 'text', text: '✅ 付款後系統會自動通知我們', size: 'sm', color: '#888888', margin: 'md' }
        ]
      }
    }
  };
  await client.pushMessage(userId, bubble);
}

// /send-payment（舊路徑）與 /api/send-payment（新路徑）都可
async function handleSendPayment(req, res) {
  const { userId, userName, amount, paymentType, customMessage } = req.body || {};
  if (!userId || !userName || !amount) {
    return res.status(400).json({ success: false, error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }
  const numAmount = parseInt(amount, 10);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ success: false, error: '金額必須是正整數' });

  try {
    const type = paymentType || 'both';
    let ecpayLink = '', linepayLink = '';
    /* 綠界 */
    if (type === 'ecpay' || type === 'both') {
      orderManager.createOrder(`EC${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, {
        userId, userName, amount: numAmount
      });
      ecpayLink = createECPayPaymentLink(userId, userName, numAmount);
      try {
        const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
        const t = await r.text();
        if (t.startsWith('http')) ecpayLink = t;
      } catch {}
    }
    /* LINE Pay（持久入口） */
    if (type === 'linepay' || type === 'both') {
      const lp = await createLinePayPayment(userId, userName, numAmount);
      if (lp.success) {
        orderManager.createOrder(lp.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);
        const persistent = `${baseURL}/payment/linepay/pay/${lp.orderId}`;
        linepayLink = persistent;
        try {
          const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistent)}`);
          const t = await r.text();
          if (t.startsWith('http')) linepayLink = t;
        } catch {}
      }
    }

    // 發 Flex（兩個中文按鈕）
    if ((type === 'both' && ecpayLink && linepayLink) ||
        (type === 'ecpay' && ecpayLink) ||
        (type === 'linepay' && linepayLink)) {
      await pushFlexPayment(userId, userName, numAmount, ecpayLink || linepayLink, linepayLink || ecpayLink);
      logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount} (${type})`);
      return res.json({ success: true });
    }

    return res.status(500).json({ success: false, error: '付款連結生成失敗' });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.post('/send-payment', handleSendPayment);
app.post('/api/send-payment', handleSendPayment);

/* ====== LINE Pay 入口／確認／取消 ====== */
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('<h3>訂單不存在</h3>');
  if (orderManager.isExpired(orderId)) return res.send('<h3>⏰ 訂單已過期（7 天）</h3>');
  if (order.status === 'paid') return res.send('<h3>✅ 訂單已付款</h3>');
  try {
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!lp.success) return res.status(500).send('<h3>LINE Pay 付款連結生成失敗</h3>');
    orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);
    res.send(`<meta charset="utf-8"><p>即將導向 LINE Pay ...</p><script>location.href=${JSON.stringify(lp.paymentUrl)}</script>`);
  } catch (e) {
    logger.logError('重新生成 LINE Pay 連結失敗', e);
    res.status(500).send('<h3>系統錯誤</h3>');
  }
});

app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId } = req.query;
  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const order = orderManager.getOrder(orderId) || {};
    const body = { amount: parseInt(order.amount || req.query.amount, 10), currency: 'TWD' };
    const sig = linePaySig(uri, body, nonce);
    const rs = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId, 'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': sig },
      body: JSON.stringify(body)
    });
    const json = await rs.json();
    if (json.returnCode === '0000') {
      if (orderId) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      if (order.userId) orderManager.updateOrderStatusByUserId(order.userId, 'paid', 'LINE Pay');

      const ADMIN = process.env.ADMIN_USER_ID;
      if (ADMIN) await client.pushMessage(ADMIN, { type: 'text', text: `🎉 LINE Pay 付款成功\n客戶:${order.userName}\n金額:NT$ ${body.amount?.toLocaleString?.() || body.amount}\n訂單:${orderId}\n交易:${transactionId}` });
      if (order.userId) await client.pushMessage(order.userId, { type: 'text', text: `✅ 付款成功\n感謝 ${order.userName}\n金額:NT$ ${body.amount}\n訂單:${orderId}` });

      return res.redirect('/payment/success');
    }
    res.send(`<meta charset="utf-8"><h3>❌ 付款確認失敗</h3><p>${json.returnMessage || ''}</p>`);
  } catch (e) {
    logger.logError('LINE Pay 確認付款失敗', e);
    res.status(500).send('<meta charset="utf-8"><h3>付款處理失敗</h3>');
  }
});
app.get('/payment/linepay/cancel', (_req, res) => res.send('<meta charset="utf-8"><h3>❌ 付款已取消</h3>'));

/* ====== 綠界回跳頁（持久） ====== */
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try {
    const form = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const html = `
      <!doctype html><meta charset="utf-8">
      <p>正在前往綠界付款頁面...</p>
      <form id="f" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">
        ${Object.keys(form).map(k=>`<input type="hidden" name="${k}" value="${form[k]}">`).join('')}
      </form>
      <script>document.getElementById('f').submit();</script>`;
    res.send(html);
  } catch (e) {
    logger.logError('付款跳轉失敗', e);
    res.status(500).send('付款連結錯誤');
  }
});

/* ====== 綠界 callback ====== */
function getPaymentTypeName(code) {
  const types = { 'Credit_CreditCard': '信用卡', 'ATM_LAND': 'ATM 轉帳', 'CVS_CVS': '超商代碼', 'BARCODE_BARCODE': '超商條碼', 'WebATM_TAISHIN': '網路 ATM' };
  return types[code] || code;
}
app.post('/payment/ecpay/callback', async (req, res) => {
  try {
    const { MerchantTradeNo, RtnCode, RtnMsg, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body || {};
    if (String(RtnCode) === '1') {
      const amount = parseInt(TradeAmt, 10);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
      const ADMIN = process.env.ADMIN_USER_ID;
      if (ADMIN) await client.pushMessage(ADMIN, { type: 'text', text: `🎉 綠界付款成功\n客戶:${userName}\n金額:NT$ ${amount}\n方式:${getPaymentTypeName(PaymentType)}\n時間:${PaymentDate}\n綠界:${MerchantTradeNo}` });
      if (userId && userId !== 'undefined') await client.pushMessage(userId, { type: 'text', text: `✅ 付款成功\n感謝 ${userName}\n金額: NT$ ${amount}\n綠界訂單:${MerchantTradeNo}` });
      logger.logToFile(`✅ 綠界付款成功: ${userName} - ${amount}`);
    } else {
      logger.logToFile(`❌ 綠界付款異常: ${RtnMsg}`);
    }
    res.send('1|OK');
  } catch (e) {
    logger.logError('處理綠界回調失敗', e);
    res.send('0|ERROR');
  }
});

/* ====== 訂單查詢維持不變 ====== */
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  const orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const now = Date.now();
  res.json({
    success: true,
    total: orders.length,
    orders: orders.map(o => ({
      ...o,
      isExpired: orderManager.isExpired(o.orderId),
      remainingTime: Math.max(0, o.expiryTime - now),
      remainingHours: Math.floor(Math.max(0, o.expiryTime - now) / 36e5)
    })),
    statistics: orderManager.getStatistics()
  });
});
app.get('/api/order/:orderId', (req, res) => {
  const o = orderManager.getOrder(req.params.orderId);
  if (!o) return res.status(404).json({ success: false, error: '找不到此訂單' });
  const now = Date.now();
  res.json({
    success: true,
    order: {
      ...o,
      isExpired: orderManager.isExpired(o.orderId),
      remainingTime: Math.max(0, o.expiryTime - now),
      remainingHours: Math.floor(Math.max(0, o.expiryTime - now) / 36e5)
    }
  });
});
app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });
  try {
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    try { const r=await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`); const t=await r.text(); if (t.startsWith('http')) ecpayLink=t; } catch{}
    if (lp.success) {
      orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);
      const persistent = `${baseURL}/payment/linepay/pay/${orderId}`;
      let shortLP = persistent;
      try { const r=await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistent)}`); const t=await r.text(); if (t.startsWith('http')) shortLP=t; } catch{}
      await pushFlexPayment(order.userId, order.userName, order.amount, ecpayLink, shortLP);
      orderManager.markReminderSent(orderId);
      return res.json({ success: true, links: { ecpay: ecpayLink, linepay: shortLP } });
    }
    res.status(500).json({ success: false, error: '重新生成 LINE Pay 連結失敗' });
  } catch (e) {
    logger.logError('續約訂單失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (ok) res.json({ success: true, message: '訂單已刪除' });
  else res.status(404).json({ success: false, error: '找不到此訂單' });
});
app.post('/api/orders/clean-expired', (_req, res) => {
  const cleaned = orderManager.cleanExpiredOrders();
  res.json({ success: true, cleaned });
});

/* ====== 自動提醒（每 12 小時掃一次；只在 10:00–20:00 間發送） ====== */
async function remindAllPending() {
  const now = new Date();
  const hour = now.getHours();
  const tz = 'Asia/Taipei';
  if (hour < 10 || hour >= 20) return; // 不打擾
  const targets = orderManager.getOrdersNeedingReminder();
  if (!targets.length) return;

  for (const order of targets) {
    try {
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!lp.success) continue;
      orderManager.createOrder(lp.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
      orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);
      orderManager.deleteOrder(order.orderId);

      const persistent = `${baseURL}/payment/linepay/pay/${lp.orderId}`;
      let linepayShort = persistent;
      try { const r=await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistent)}`); const t=await r.text(); if (t.startsWith('http')) linepayShort=t; } catch {}
      let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
      try { const r=await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`); const t=await r.text(); if (t.startsWith('http')) ecpayLink=t; } catch {}
      await pushFlexPayment(order.userId, order.userName, order.amount, ecpayLink, linepayShort);
      orderManager.markReminderSent(lp.orderId);
    } catch (e) {
      logger.logError(`自動提醒失敗: ${order.orderId}`, e);
    }
  }
}

/* ====== 其他頁面 ====== */
app.get('/payment', (_req, res) => res.sendFile('payment.html', { root: './public' }));
app.get('/payment/success', (_req, res) =>
  res.send('<meta charset="utf-8"><h3>✅ 付款已完成</h3><p>感謝您的支付</p>')
);

/* ====== 啟動 ====== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器運行中，Port:${PORT}`);
  logger.logToFile(`伺服器正在運行,端口:${PORT}`);
  try { await customerDB.loadAllCustomers(); console.log('✅ 客戶資料載入完成'); }
  catch (e) { console.error('❌ 客戶資料載入失敗:', e.message); }
  setInterval(() => orderManager.cleanExpiredOrders(), 24 * 60 * 60 * 1000);
  setInterval(remindAllPending, 12 * 60 * 60 * 1000);
});
// －－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－ End of index.js