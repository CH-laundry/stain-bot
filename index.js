/**
 * index.js — C.H 精緻洗衣（完整版 - 已修改）
 * 功能：
 *  - 短鏈接系統：每個訂單生成獨特短碼 /p/ABC123
 *  - 永久入口：每次打開都重新生成 20 分鐘 LINE Pay 網頁
 *  - 定時提醒：每天 12:00～17:00 之間隨機發送（避免騷擾）
 *  - 付款成功即停止：任一通道付款 → 訂單完成 → 停止所有提醒
 *  - 雙通知：支付成功同時通知管理員 + 客人
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const { Client } = require('@line/bot-sdk');
const cron = require('node-cron');

// === 既有服務 ===
const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
const { createECPayPaymentLink } = require('./services/openai');
const customerDB = require('./services/customerDatabase');
const messageHandler = require('./services/message');

// === 基本設定 ===
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage() });

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'U5099169723d6e83588c5f23dfaf6f9cf';

// === LINE Bot ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// === LINE Pay 設定 ===
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};

// === 短碼映射（記憶體 + 檔案） ===
const SHORT_CODES_FILE = path.join(__dirname, 'data/shortCodes.json');
let shortCodeMap = {}; // { ABC123: { orderId, createdAt } }

function ensureShortCodesFile() {
  const dir = path.dirname(SHORT_CODES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SHORT_CODES_FILE)) {
    fs.writeFileSync(SHORT_CODES_FILE, JSON.stringify({}), 'utf8');
  }
  try {
    shortCodeMap = JSON.parse(fs.readFileSync(SHORT_CODES_FILE, 'utf8'));
  } catch {
    shortCodeMap = {};
  }
}
ensureShortCodesFile();

function saveShortCodes() {
  fs.writeFileSync(SHORT_CODES_FILE, JSON.stringify(shortCodeMap, null, 2), 'utf8');
}

function generateShortCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = Array(6).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (shortCodeMap[code]);
  return code;
}

function createShortCode(orderId) {
  const code = generateShortCode();
  shortCodeMap[code] = { orderId, createdAt: Date.now() };
  saveShortCodes();
  return code;
}

// === LINE Pay 簽名 ===
function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// === 建立 LINE Pay 付款請求 ===
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
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
        confirmUrl: `${BASE_URL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl: `${BASE_URL}/payment/linepay/cancel`
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
      return {
        success: true,
        orderId,
        transactionId: result.info.transactionId,
        paymentUrl: result.info.paymentUrl.web
      };
    }
    logger.logToFile(`❌ LINE Pay 請求失敗: ${result.returnCode} - ${result.returnMessage}`);
    return { success: false, error: result.returnMessage };
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// === 同步儲存：客戶編號 + 訊息模板 ===
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE = path.join(DATA_DIR, 'messageTemplates.json');

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
ensureDataFiles();
const readJSON = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, o) => fs.writeFileSync(fp, JSON.stringify(o, null, 2));

// ========== 健康檢查 ==========
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ========== 客戶資料 API ==========
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success: false, error: '缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    return res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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

// ========== 訊息模板 API ==========
app.get('/api/templates', (_req, res) => {
  try { res.json({ success: true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success: false, error: '缺少 content' });
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
    arr[idx] = content ?? arr[idx];
    writeJSON(TPL_FILE, arr);
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

// ========== 使用者清單 ==========
app.get('/api/users', (_req, res) => {
  try {
    const users = customerDB.getAllCustomers?.() || [];
    res.json({ success: true, total: users.length, users });
  } catch (e) {
    res.json({ success: true, total: 0, users: [] });
  }
});

// ========== 訂單查詢/操作 ==========
app.get('/api/orders', (_req, res) => {
  const orders = orderManager.getAllOrders();
  const enriched = orders.map(o => ({
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  }));
  res.json({ success: true, total: enriched.length, orders: enriched, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const o = orderManager.getOrder(req.params.orderId);
  if (!o) return res.status(404).json({ success: false, error: '找不到此訂單' });
  const enriched = {
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  };
  res.json({ success: true, order: enriched });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) throw new Error(linePayResult.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    const shortCode = createShortCode(orderId);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const payEntryUrl = `${BASE_URL}/p/${shortCode}`;

    await pushPaymentFlex(
      order.userId,
      order.userName,
      order.amount,
      ecpayLink,
      payEntryUrl,
      '🔄 付款連結已重新生成'
    );

    orderManager.markReminderSent(orderId);
    res.json({ success: true, message: '已續約並重發連結', order });
  } catch (e) {
    logger.logError('續約失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (!ok) return res.status(404).json({ success: false, error: '找不到此訂單' });
  res.json({ success: true, message: '訂單已刪除' });
});

app.post('/api/orders/send-reminders', async (_req, res) => {
  const targets = orderManager.getOrdersNeedingReminder();
  let sent = 0;

  for (const order of targets) {
    try {
      const linePay = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!linePay.success) continue;

      orderManager.updatePaymentInfo(order.orderId, linePay.transactionId, linePay.paymentUrl);

      const shortCode = createShortCode(order.orderId);
      const payEntryUrl = `${BASE_URL}/p/${shortCode}`;
      const ecpay = createECPayPaymentLink(order.userId, order.userName, order.amount);

      await pushPaymentFlex(
        order.userId,
        order.userName,
        order.amount,
        ecpay,
        payEntryUrl,
        '😊 付款提醒'
      );

      orderManager.markReminderSent(order.orderId);
      sent++;
    } catch (e) {
      logger.logError('批次提醒失敗', e);
    }
  }

  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent });
});

// ========== 發送付款（前端主按鈕） ==========
app.post('/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) {
      return res.status(400).json({ success: false, error: '缺少必要參數' });
    }
    const amt = parseInt(amount, 10);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: '金額必須是正整數' });
    }

    const type = paymentType || 'both';
    let ecpayLink = null;
    let payEntryUrl = null;

    const orderId = `${type === 'linepay' ? 'LP' : type === 'ecpay' ? 'EC' : 'OD'}${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    orderManager.createOrder(orderId, { userId, userName, amount: amt });

    if (type === 'both' || type === 'ecpay') {
      ecpayLink = createECPayPaymentLink(userId, userName, amt);
    }

    if (type === 'both' || type === 'linepay') {
      const linePay = await createLinePayPayment(userId, userName, amt);
      if (linePay.success) {
        orderManager.updatePaymentInfo(orderId, linePay.transactionId, linePay.paymentUrl);
        const shortCode = createShortCode(orderId);
        payEntryUrl = `${BASE_URL}/p/${shortCode}`;
      } else {
        logger.logToFile('❌ LINE Pay 付款請求失敗');
      }
    }

    await pushPaymentFlex(
      userId,
      userName,
      amt,
      ecpayLink,
      payEntryUrl,
      customMessage || '您的專屬付款連結如下'
    );

    res.json({
      success: true,
      message: '付款連結已送出',
      data: { orderId, ecpayLink, payEntryUrl }
    });
  } catch (e) {
    logger.logError('發送付款失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== 短碼重定向 ==========
app.get('/p/:code', async (req, res) => {
  const { code } = req.params;
  const mapping = shortCodeMap[code];
  
  if (!mapping) {
    return res.status(404).send(htmlMsg('❌ 鏈接失效', '此付款連結已過期或不存在'));
  }

  const { orderId } = mapping;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(htmlMsg('❌ 訂單不存在', '找不到此訂單'));
  }

  if (orderManager.isExpired(orderId)) {
    const hours = Math.floor((Date.now() - order.createdAt) / 36e5);
    return res.send(htmlMsg('⏰ 訂單已過期', `此訂單已超過 7 天（約 ${hours} 小時）`));
  }

  if (order.status === 'paid') {
    return res.send(htmlMsg('✅ 訂單已付款', `訂單編號：${orderId}`));
  }

  // 重新生成 LINE Pay 頁面（每次都新鮮的 20 分鐘）
  try {
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!lp.success) throw new Error(lp.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);

    res.send(`
      <!DOCTYPE html><meta charset="UTF-8">
      <title>前往 LINE Pay</title>
      <div style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>💳 正在前往 LINE Pay</h2>
        <p>訂單編號：${orderId}</p>
        <p>金額：NT$ ${order.amount.toLocaleString()}</p>
        <p>若未自動跳轉，<a href="${lp.paymentUrl}">請點此</a></p>
      </div>
      <script>location.href=${JSON.stringify(lp.paymentUrl)}</script>
    `);
  } catch (e) {
    logger.logError('短碼入口刷新失敗', e);
    res.status(500).send(htmlMsg('❌ 生成失敗', e.message));
  }
});

// ========== LINE Pay 付款確認 ==========
app.get('/payment/linepay/confirm', async (req, res) => {
  try {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    const o = orderManager.getOrder(orderId);
    if (o && orderManager.isExpired(orderId)) {
      return res.send(htmlMsg('⏰ 訂單已過期', '此訂單超過 7 天'));
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount, 10), currency: 'TWD' };
    const sig = generateLinePaySignature(uri, body, nonce);
    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': sig
      },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    
    if (result.returnCode === '0000') {
      if (o) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 成功，已標記 ${updated} 筆為已付`);

      // 通知管理員
      if (ADMIN_USER_ID) {
        try {
          await client.pushMessage(ADMIN_USER_ID, {
            type: 'text',
            text: `🎉 LINE Pay 付款成功\n客戶:${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount, 10).toLocaleString()}\n訂單:${orderId}\n交易:${transactionId}`
          });
        } catch (err) {
          logger.logError('管理員通知失敗', err);
        }
      }

      // 通知客人
      if (userId && userId !== 'undefined') {
        try {
          await client.pushMessage(userId, {
            type: 'text',
            text: `✅ 付款成功\n感謝 ${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount, 10).toLocaleString()}\n訂單:${orderId}`
          });
        } catch (err) {
          logger.logError('客人通知失敗', err);
        }
      }

      return res.redirect('/payment/success');
    }
    res.send(htmlMsg('❌ 付款失敗', result.returnMessage || '請聯繫客服'));
  } catch (e) {
    logger.logError('LINE Pay 確認失敗', e);
    res.status(500).send(htmlMsg('❌ 付款處理失敗', e.message));
  }
});

// ========== 綠界回調 ==========
app.post('/payment/ecpay/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const {
      MerchantTradeNo, RtnCode, RtnMsg, TradeAmt,
      PaymentDate, PaymentType,
      CustomField1: userId, CustomField2: userName
    } = req.body;

    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt, 10);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
      logger.logToFile(`✅ 綠界成功，已標記 ${updated} 筆為已付`);

      // 通知管理員
      if (ADMIN_USER_ID) {
        try {
          await client.pushMessage(ADMIN_USER_ID, {
            type: 'text',
            text: `🎉 綠界付款成功\n客戶:${userName}\n金額:NT$ ${amount.toLocaleString()}\n類型:${getPaymentTypeName(PaymentType)}\n訂單:${MerchantTradeNo}\n時間:${PaymentDate}`
          });
        } catch (err) {
          logger.logError('管理員通知失敗', err);
        }
      }

      // 通知客人
      if (userId && userId !== 'undefined') {
        try {
          await client.pushMessage(userId, {
            type: 'text',
            text: `✅ 付款成功\n感謝 ${userName}\n金額:NT$ ${amount.toLocaleString()}\n綠界訂單:${MerchantTradeNo}`
          });
        } catch (err) {
          logger.logError('客人通知失敗', err);
        }
      }
    } else {
      logger.logToFile(`❌ 綠界付款異常: ${RtnMsg}`);
    }
    res.send('1|OK');
  } catch (e) {
    logger.logError('綠界回調錯誤', e);
    res.send('0|ERROR');
  }
});

// ========== 其他頁面 ==========
app.get('/payment/success', (_req, res) => {
  res.send(htmlMsg('✅ 付款完成', '感謝您的支付，我們會盡快處理您的訂單'));
});
app.get('/payment/linepay/cancel', (_req, res) => {
  res.send(htmlMsg('❌ 付款取消', '您已取消此次付款'));
});

// ========== LINE Webhook ==========
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
          const text = event.message.text?.trim() || '';
          logger.logUserMessage(userId, text);
          await messageHandler.handleTextMessage(userId, text, text);
        } else if (event.message.type === 'image') {
          logger.logUserMessage(userId, '上傳了一張圖片');
          await messageHandler.handleImageMessage(userId, event.message.id);
        }
      } catch (err) {
        logger.logError('處理事件錯誤', err, event.source?.userId);
      }
    }
  } catch (err) {
    logger.logError('Webhook 全局錯誤', err);
  }
});

async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (e) {
    logger.logError('記錄用戶資料失敗', e, userId);
  }
}

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

function htmlMsg(title, body) {
  return `
  <!DOCTYPE html><meta charset="UTF-8">
  <title>${title}</title>
  <div style="font-family:sans-serif;text-align:center;padding:48px;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;color:#fff">
    <div style="max-width:560px;margin:0 auto;background:rgba(255,255,255,.12);border-radius:20px;padding:32px">
      <h1 style="margin:0 0 12px">${title}</h1>
      <p style="font-size:18px;line-height:1.
/**
 * index.js — C.H 精緻洗衣（完整版 - 已修改）
 * 功能：
 *  - 短鏈接系統：每個訂單生成獨特短碼 /p/ABC123
 *  - 永久入口：每次打開都重新生成 20 分鐘 LINE Pay 網頁
 *  - 定時提醒：每天 12:00～17:00 之間隨機發送（避免騷擾）
 *  - 付款成功即停止：任一通道付款 → 訂單完成 → 停止所有提醒
 *  - 雙通知：支付成功同時通知管理員 + 客人
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const { Client } = require('@line/bot-sdk');
const cron = require('node-cron');

// === 既有服務 ===
const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
const { createECPayPaymentLink } = require('./services/openai');
const customerDB = require('./services/customerDatabase');
const messageHandler = require('./services/message');

// === 基本設定 ===
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage() });

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'U5099169723d6e83588c5f23dfaf6f9cf';

// === LINE Bot ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// === LINE Pay 設定 ===
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};

// === 短碼映射（記憶體 + 檔案） ===
const SHORT_CODES_FILE = path.join(__dirname, 'data/shortCodes.json');
let shortCodeMap = {}; // { ABC123: { orderId, createdAt } }

function ensureShortCodesFile() {
  const dir = path.dirname(SHORT_CODES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SHORT_CODES_FILE)) {
    fs.writeFileSync(SHORT_CODES_FILE, JSON.stringify({}), 'utf8');
  }
  try {
    shortCodeMap = JSON.parse(fs.readFileSync(SHORT_CODES_FILE, 'utf8'));
  } catch {
    shortCodeMap = {};
  }
}
ensureShortCodesFile();

function saveShortCodes() {
  fs.writeFileSync(SHORT_CODES_FILE, JSON.stringify(shortCodeMap, null, 2), 'utf8');
}

function generateShortCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = Array(6).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (shortCodeMap[code]);
  return code;
}

function createShortCode(orderId) {
  const code = generateShortCode();
  shortCodeMap[code] = { orderId, createdAt: Date.now() };
  saveShortCodes();
  return code;
}

// === LINE Pay 簽名 ===
function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// === 建立 LINE Pay 付款請求 ===
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
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
        confirmUrl: `${BASE_URL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl: `${BASE_URL}/payment/linepay/cancel`
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
      return {
        success: true,
        orderId,
        transactionId: result.info.transactionId,
        paymentUrl: result.info.paymentUrl.web
      };
    }
    logger.logToFile(`❌ LINE Pay 請求失敗: ${result.returnCode} - ${result.returnMessage}`);
    return { success: false, error: result.returnMessage };
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// === 同步儲存：客戶編號 + 訊息模板 ===
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE = path.join(DATA_DIR, 'messageTemplates.json');

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
ensureDataFiles();
const readJSON = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, o) => fs.writeFileSync(fp, JSON.stringify(o, null, 2));

// ========== 健康檢查 ==========
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ========== 客戶資料 API ==========
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success: false, error: '缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    return res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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

// ========== 訊息模板 API ==========
app.get('/api/templates', (_req, res) => {
  try { res.json({ success: true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success: false, error: '缺少 content' });
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
    arr[idx] = content ?? arr[idx];
    writeJSON(TPL_FILE, arr);
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

// ========== 使用者清單 ==========
app.get('/api/users', (_req, res) => {
  try {
    const users = customerDB.getAllCustomers?.() || [];
    res.json({ success: true, total: users.length, users });
  } catch (e) {
    res.json({ success: true, total: 0, users: [] });
  }
});

// ========== 訂單查詢/操作 ==========
app.get('/api/orders', (_req, res) => {
  const orders = orderManager.getAllOrders();
  const enriched = orders.map(o => ({
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  }));
  res.json({ success: true, total: enriched.length, orders: enriched, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const o = orderManager.getOrder(req.params.orderId);
  if (!o) return res.status(404).json({ success: false, error: '找不到此訂單' });
  const enriched = {
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  };
  res.json({ success: true, order: enriched });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) throw new Error(linePayResult.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    const shortCode = createShortCode(orderId);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const payEntryUrl = `${BASE_URL}/p/${shortCode}`;

    await pushPaymentFlex(
      order.userId,
      order.userName,
      order.amount,
      ecpayLink,
      payEntryUrl,
      '🔄 付款連結已重新生成'
    );

    orderManager.markReminderSent(orderId);
    res.json({ success: true, message: '已續約並重發連結', order });
  } catch (e) {
    logger.logError('續約失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (!ok) return res.status(404).json({ success: false, error: '找不到此訂單' });
  res.json({ success: true, message: '訂單已刪除' });
});

app.post('/api/orders/send-reminders', async (_req, res) => {
  const targets = orderManager.getOrdersNeedingReminder();
  let sent = 0;

  for (const order of targets) {
    try {
      const linePay = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!linePay.success) continue;

      orderManager.updatePaymentInfo(order.orderId, linePay.transactionId, linePay.paymentUrl);

      const shortCode = createShortCode(order.orderId);
      const payEntryUrl = `${BASE_URL}/p/${shortCode}`;
      const ecpay = createECPayPaymentLink(order.userId, order.userName, order.amount);

      await pushPaymentFlex(
        order.userId,
        order.userName,
        order.amount,
        ecpay,
        payEntryUrl,
        '😊 付款提醒'
      );

      orderManager.markReminderSent(order.orderId);
      sent++;
    } catch (e) {
      logger.logError('批次提醒失敗', e);
    }
  }

  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent });
});

// ========== 發送付款（前端主按鈕） ==========
app.post('/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) {
      return res.status(400).json({ success: false, error: '缺少必要參數' });
    }
    const amt = parseInt(amount, 10);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: '金額必須是正整數' });
    }

    const type = paymentType || 'both';
    let ecpayLink = null;
    let payEntryUrl = null;

    const orderId = `${type === 'linepay' ? 'LP' : type === 'ecpay' ? 'EC' : 'OD'}${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    orderManager.createOrder(orderId, { userId, userName, amount: amt });

    if (type === 'both' || type === 'ecpay') {
      ecpayLink = createECPayPaymentLink(userId, userName, amt);
    }

    if (type === 'both' || type === 'linepay') {
      const linePay = await createLinePayPayment(userId, userName, amt);
      if (linePay.success) {
        orderManager.updatePaymentInfo(orderId, linePay.transactionId, linePay.paymentUrl);
        const shortCode = createShortCode(orderId);
        payEntryUrl = `${BASE_URL}/p/${shortCode}`;
      } else {
        logger.logToFile('❌ LINE Pay 付款請求失敗');
      }
    }

    await pushPaymentFlex(
      userId,
      userName,
      amt,
      ecpayLink,
      payEntryUrl,
      customMessage || '您的專屬付款連結如下'
    );

    res.json({
      success: true,
      message: '付款連結已送出',
      data: { orderId, ecpayLink, payEntryUrl }
    });
  } catch (e) {
    logger.logError('發送付款失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== 短碼重定向 ==========
app.get('/p/:code', async (req, res) => {
  const { code } = req.params;
  const mapping = shortCodeMap[code];
  
  if (!mapping) {
    return res.status(404).send(htmlMsg('❌ 鏈接失效', '此付款連結已過期或不存在'));
  }

  const { orderId } = mapping;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(htmlMsg('❌ 訂單不存在', '找不到此訂單'));
  }

  if (orderManager.isExpired(orderId)) {
    const hours = Math.floor((Date.now() - order.createdAt) / 36e5);
    return res.send(htmlMsg('⏰ 訂單已過期', `此訂單已超過 7 天（約 ${hours} 小時）`));
  }

  if (order.status === 'paid') {
    return res.send(htmlMsg('✅ 訂單已付款', `訂單編號：${orderId}`));
  }

  // 重新生成 LINE Pay 頁面（每次都新鮮的 20 分鐘）
  try {
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!lp.success) throw new Error(lp.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);

    res.send(`
      <!DOCTYPE html><meta charset="UTF-8">
      <title>前往 LINE Pay</title>
      <div style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>💳 正在前往 LINE Pay</h2>
        <p>訂單編號：${orderId}</p>
        <p>金額：NT$ ${order.amount.toLocaleString()}</p>
        <p>若未自動跳轉，<a href="${lp.paymentUrl}">請點此</a></p>
      </div>
      <script>location.href=${JSON.stringify(lp.paymentUrl)}</script>
    `);
  } catch (e) {
    logger.logError('短碼入口刷新失敗', e);
    res.status(500).send(htmlMsg('❌ 生成失敗', e.message));
  }
});

// ========== LINE Pay 付款確認 ==========
app.get('/payment/linepay/confirm', async (req, res) => {
  try {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    const o = orderManager.getOrder(orderId);
    if (o && orderManager.isExpired(orderId)) {
      return res.send(htmlMsg('⏰ 訂單已過期', '此訂單超過 7 天'));
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount, 10), currency: 'TWD' };
    const sig = generateLinePaySignature(uri, body, nonce);
    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': sig
      },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    
    if (result.returnCode === '0000') {
      if (o) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 成功，已標記 ${updated} 筆為已付`);

      // 通知管理員
      if (ADMIN_USER_ID) {
        try {
          await client.pushMessage(ADMIN_USER_ID, {
            type: 'text',
            text: `🎉 LINE Pay 付款成功\n客戶:${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount, 10).toLocaleString()}\n訂單:${orderId}\n交易:${transactionId}`
          });
        } catch (err) {
          logger.logError('管理員通知失敗', err);
        }
      }

      // 通知客人
      if (userId && userId !== 'undefined') {
        try {
          await client.pushMessage(userId, {
            type: 'text',
            text: `✅ 付款成功\n感謝 ${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount, 10).toLocaleString()}\n訂單:${orderId}`
          });
        } catch (err) {
          logger.logError('客人通知失敗', err);
        }
      }

      return res.redirect('/payment/success');
    }
    res.send(htmlMsg('❌ 付款失敗', result.returnMessage || '請聯繫客服'));
  } catch (e) {
    logger.logError('LINE Pay 確認失敗', e);
    res.status(500).send(htmlMsg('❌ 付款處理失敗', e.message));
  }
});

// ========== 綠界回調 ==========
app.post('/payment/ecpay/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const {
      MerchantTradeNo, RtnCode, RtnMsg, TradeAmt,
      PaymentDate, PaymentType,
      CustomField1: userId, CustomField2: userName
    } = req.body;

    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt, 10);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
      logger.logToFile(`✅ 綠界成功，已標記 ${updated} 筆為已付`);

      // 通知管理員
      if (ADMIN_USER_ID) {
        try {
          await client.pushMessage(ADMIN_USER_ID, {
            type: 'text',
            text: `🎉 綠界付款成功\n客戶:${userName}\n金額:NT$ ${amount.toLocaleString()}\n類型:${getPaymentTypeName(PaymentType)}\n訂單:${MerchantTradeNo}\n時間:${PaymentDate}`
          });
        } catch (err) {
          logger.logError('管理員通知失敗', err);
        }
      }

      // 通知客人
      if (userId && userId !== 'undefined') {
        try {
          await client.pushMessage(userId, {
            type: 'text',
            text: `✅ 付款成功\n感謝 ${userName}\n金額:NT$ ${amount.toLocaleString()}\n綠界訂單:${MerchantTradeNo}`
          });
        } catch (err) {
          logger.logError('客人通知失敗', err);
        }
      }
    } else {
      logger.logToFile(`❌ 綠界付款異常: ${RtnMsg}`);
    }
    res.send('1|OK');
  } catch (e) {
    logger.logError('綠界回調錯誤', e);
    res.send('0|ERROR');
  }
});

// ========== 其他頁面 ==========
app.get('/payment/success', (_req, res) => {
  res.send(htmlMsg('✅ 付款完成', '感謝您的支付，我們會盡快處理您的訂單'));
});
app.get('/payment/linepay/cancel', (_req, res) => {
  res.send(htmlMsg('❌ 付款取消', '您已取消此次付款'));
});

// ========== LINE Webhook ==========
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
          const text = event.message.text?.trim() || '';
          logger.logUserMessage(userId, text);
          await messageHandler.handleTextMessage(userId, text, text);
        } else if (event.message.type === 'image') {
          logger.logUserMessage(userId, '上傳了一張圖片');
          await messageHandler.handleImageMessage(userId, event.message.id);
        }
      } catch (err) {
        logger.logError('處理事件錯誤', err, event.source?.userId);
      }
    }
  } catch (err) {
    logger.logError('Webhook 全局錯誤', err);
  }
});

async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (e) {
    logger.logError('記錄用戶資料失敗', e, userId);
  }
}

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

function htmlMsg(title, body) {
  return `
  <!DOCTYPE html><meta charset="UTF-8">
  <title>${title}</title>
  <div style="font-family:sans-serif;text-align:center;padding:48px;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;color:#fff">
    <div style="max-width:560px;margin:0 auto;background:rgba(255,255,255,.12);border-radius:20px;padding:32px">
      <h1 style="margin:0 0 12px">${title}</h1>
      <p style="font-size:18px;line-height:1.7">${body}</p>
      <p style="margin-top:24px"><a style="color:#fff;text-decoration:underline" href="/">返回首頁</a></p>
    </div>
  </div>`;
}

// 用 Flex 傳「中文按鈕」
async function pushPaymentFlex(userId, userName, amount, ecpayLink, payEntryUrl, headerText) {
  const actions = [];
  if (ecpayLink) {
    actions.push({
      type: 'button',
      style: 'primary',
      color: '#52c41a',
      action: { type: 'uri', label: '綠界信用卡', uri: ecpayLink }
    });
  }
  if (payEntryUrl) {
    actions.push({
      type: 'button',
      style: 'primary',
      color: '#00c300',
      action: { type: 'uri', label: 'LINE Pay', uri: payEntryUrl }
    });
  }

  const flex = {
    type: 'flex',
    altText: '付款連結',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: headerText, weight: 'bold', size: 'lg', color: '#ffffff' }
        ],
        backgroundColor: '#667eea'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `客戶：${userName}`, size: 'md', weight: 'bold' },
          { type: 'text', text: `金額：NT$ ${amount.toLocaleString()}`, size: 'md' },
          { type: 'separator', margin: 'lg' },
          ...actions
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '付款後系統會自動通知我們', size: 'xs', color: '#888888', wrap: true }
        ]
      }
    }
  };

  await client.pushMessage(userId, flex);
}

// ========== 定時提醒：每天 12:00～17:00 隨機時間發送 ==========
cron.schedule('0 * 12-16 * * *', async () => {
  try {
    // 在 12:00～16:59 之間每小時檢查一次，加上隨機延遲避免集中發送
    const randomDelay = Math.random() * 30 * 60 * 1000; // 0～30 分鐘隨機延遲
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    const targets = orderManager.getOrdersNeedingReminder();
    if (targets.length === 0) return;

    for (const order of targets) {
      try {
        const linePay = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (!linePay.success) continue;

        orderManager.updatePaymentInfo(order.orderId, linePay.transactionId, linePay.paymentUrl);

        const shortCode = createShortCode(order.orderId);
        const entry = `${BASE_URL}/p/${shortCode}`;
        const ecpay = createECPayPaymentLink(order.userId, order.userName, order.amount);

        await pushPaymentFlex(
          order.userId,
          order.userName,
          order.amount,
          ecpay,
          entry,
          '⏰ 付款提醒'
        );
        orderManager.markReminderSent(order.orderId);
        logger.logToFile(`✅ 定時提醒發送：${order.orderId} 給 ${order.userName}`);
      } catch (e) {
        logger.logError('定時提醒單筆失敗', e);
      }
    }
  } catch (e) {
    logger.logError('定時提醒錯誤', e);
  }
}, { timezone: 'Asia/Taipei' });

// ========== 每天 00:30 清理過期訂單 ==========
cron.schedule('30 0 * * *', async () => {
  try {
    const cleaned = orderManager.cleanExpiredOrders();
    logger.logToFile(`🧹 每日清理過期訂單完成，共清理 ${cleaned} 筆`);
  } catch (e) {
    logger.logError('清理過期訂單失敗', e);
  }
}, { timezone: 'Asia/Taipei' });

// ========== 啟動 ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on ${PORT}`);
  logger.logToFile(`伺服器正在運行, 端口:${PORT}`);
  try {
    await customerDB.loadAllCustomers?.();
    console.log('✅ 客戶資料載入完成');
  } catch (e) {
    console.log('⚠️ 客戶資料載入失敗（略過）', e.message);
  }
});