/**
 * index.js — C.H 精緻洗衣（完整）
 * 功能：
 *  - /api/customer-meta  (GET / POST(save) / DELETE)
 *  - /api/templates      (GET / POST / PUT / DELETE)
 *  - /send-payment       (同時支援 綠界 + LINE Pay；以 Flex 中文按鈕送出)
 *  - /api/orders ...     (查詢、續期重發、刪除、批次提醒、清除過期)
 *  - /payment/linepay/pay/:orderId  永久入口（每次打開會重新要 20 分鐘 LINE Pay 網頁）
 *  - /payment/linepay/confirm       付款確認（任一通道付成功 → 停止提醒）
 *  - /payment/ecpay/callback        綠界回調
 *  - node-cron 每天 10:00 檢查，符合「建立滿 2 天且距上次提醒滿 2 天」則自動提醒
 *  - 完整 JSON 回傳、CORS，行動裝置可用
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

// === 你專案既有服務 ===
const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
// 綠界付款表單產生器（你原本就這樣 import）
const { createECPayPaymentLink } = require('./services/openai');
// 使用者資料（你原本有）
const customerDB = require('./services/customerDatabase');
const messageHandler = require('./services/message');

// === 基本設定 ===
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage() });

// 你的公開網域（行動裝置一定用這個）：
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

// === LINE Bot ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// === LINE Pay 設定（正式） ===
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

// 建立 LINE Pay 付款請求（回傳永久入口要用的 transaction 參數）
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
        // confirm 這裡只回傳 transactionId，真正的 orderId 我們用 query 補上
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

// === 同步儲存：客戶編號 + 訊息模板（檔案） ===
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
ensureDataFiles();
const readJSON  = (fp)    => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, o) => fs.writeFileSync(fp, JSON.stringify(o, null, 2));

// ========== 健康檢查 ==========
app.get('/api/health', (_req, res) => res.json({ ok:true, ts: Date.now() }));

// ========== 客戶資料（編號/姓名/UserID）API ==========
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success:true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 儲存/更新 { number?, name, userId }
app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success:false, error:'缺少 name 或 userId' });

    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    return res.json({ success:true, number:no, data:meta.map[no] });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

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

// ========== 訊息模板 API ==========
app.get('/api/templates', (_req, res) => {
  try { res.json({ success:true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr[idx] = content ?? arr[idx];
    writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(idx, 1); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// ========== 使用者清單（供右側載入） ==========
app.get('/api/users', (_req, res) => {
  try {
    const users = customerDB.getAllCustomers?.() || [];
    res.json({ success:true, total: users.length, users });
  } catch (e) {
    res.json({ success:true, total:0, users:[] }); // 不讓前端爆
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
  res.json({ success:true, total: enriched.length, orders: enriched, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const o = orderManager.getOrder(req.params.orderId);
  if (!o) return res.status(404).json({ success:false, error:'找不到此訂單' });
  const enriched = {
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  };
  res.json({ success:true, order: enriched });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  try {
    // 重新產生 LINE Pay（但入口仍用 /payment/linepay/pay/:orderId）
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) throw new Error(linePayResult.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    // 綠界連結
    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);

    // 送 Flex 中文按鈕
    await pushPaymentFlex(
      order.userId,
      order.userName,
      order.amount,
      ecpayLink,
      `${BASE_URL}/payment/linepay/pay/${orderId}`,
      '🔄 付款連結已重新生成'
    );

    orderManager.markReminderSent(orderId);
    res.json({ success:true, message:'已續約並重發連結', order });
  } catch (e) {
    logger.logError('續約失敗', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (!ok) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({ success:true, message:'訂單已刪除' });
});

app.post('/api/orders/send-reminders', async (_req, res) => {
  const targets = orderManager.getOrdersNeedingReminder();
  let sent = 0;

  for (const order of targets) {
    try {
      const linePay = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!linePay.success) continue;

      // 保持原訂單 ID 不變（使用永久入口），只更新付款資訊
      orderManager.updatePaymentInfo(order.orderId, linePay.transactionId, linePay.paymentUrl);

      const lineEntry = `${BASE_URL}/payment/linepay/pay/${order.orderId}`;
      const ecpay = createECPayPaymentLink(order.userId, order.userName, order.amount);

      await pushPaymentFlex(
        order.userId,
        order.userName,
        order.amount,
        ecpay,
        lineEntry,
        '😊 付款提醒'
      );

      orderManager.markReminderSent(order.orderId);
      sent++;
    } catch (e) {
      logger.logError('批次提醒失敗', e);
    }
  }

  res.json({ success:true, message:`已發送 ${sent} 筆付款提醒`, sent });
});

// ========== 發送付款（前端主按鈕） ==========
app.post('/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) {
      return res.status(400).json({ success:false, error:'缺少必要參數' });
    }
    const amt = parseInt(amount, 10);
    if (!Number.isInteger(amt) || amt <= 0) {
      return res.status(400).json({ success:false, error:'金額必須是正整數' });
    }

    const type = paymentType || 'both';
    let ecpayLink = null;
    let linepayEntry = null;

    // 產生訂單（用我們自己的 orderId）
    const orderId = `${type === 'linepay' ? 'LP' : type === 'ecpay' ? 'EC' : 'OD'}${Date.now()}${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    orderManager.createOrder(orderId, { userId, userName, amount: amt });

    if (type === 'both' || type === 'ecpay') {
      ecpayLink = createECPayPaymentLink(userId, userName, amt);
    }

    if (type === 'both' || type === 'linepay') {
      const linePay = await createLinePayPayment(userId, userName, amt);
      if (linePay.success) {
        // 更新付款資訊到同一筆訂單（永久入口）
        orderManager.updatePaymentInfo(orderId, linePay.transactionId, linePay.paymentUrl);
        linepayEntry = `${BASE_URL}/payment/linepay/pay/${orderId}`;
      } else {
        logger.logToFile('❌ LINE Pay 付款請求失敗');
      }
    }

    // 送 Flex 中文按鈕（LINE 文字無法做超連結，Flex 才能用「中文按鈕」）
    await pushPaymentFlex(
      userId,
      userName,
      amt,
      ecpayLink,
      linepayEntry,
      customMessage || '您的專屬付款連結如下'
    );

    res.json({
      success:true,
      message:'付款連結已送出',
      data:{ orderId, ecpayLink, linepayEntry }
    });
  } catch (e) {
    logger.logError('發送付款失敗', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

// ========== 永久入口：每次開啟即時取 LINE Pay 20 分鐘頁 ==========
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) {
    return res.status(404).send(htmlMsg('❌ 訂單不存在', '找不到此訂單'));
  }
  if (orderManager.isExpired(orderId)) {
    const hours = Math.floor((Date.now() - order.createdAt)/36e5);
    return res.send(htmlMsg('⏰ 訂單已過期', `此訂單已超過 7 天（約 ${hours} 小時）`));
  }
  if (order.status === 'paid') {
    return res.send(htmlMsg('✅ 訂單已付款', `訂單編號：${orderId}`));
  }

  try {
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!lp.success) throw new Error(lp.error || 'LINE Pay 失敗');

    orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);

    // 自動前往最新 LINE Pay 頁（官方頁 20 分鐘），但你這個入口 URL 永久可用
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
    logger.logError('永久入口刷新失敗', e);
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
        'Content-Type':'application/json',
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

      const ADMIN = process.env.ADMIN_USER_ID;
      if (ADMIN) {
        await client.pushMessage(ADMIN, { type:'text', text:
          `🎉 LINE Pay 付款成功\n客戶:${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount,10).toLocaleString()}\n訂單:${orderId}\n交易:${transactionId}` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type:'text', text:
          `✅ 付款成功\n感謝 ${decodeURIComponent(userName)}\n金額:NT$ ${parseInt(amount,10).toLocaleString()}\n訂單:${orderId}` });
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
app.post('/payment/ecpay/callback', express.urlencoded({ extended:false }), async (req, res) => {
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

      const ADMIN = process.env.ADMIN_USER_ID;
      if (ADMIN) {
        await client.pushMessage(ADMIN, { type:'text', text:
          `🎉 綠界付款成功\n客戶:${userName}\n金額:NT$ ${amount.toLocaleString()}\n類型:${getPaymentTypeName(PaymentType)}\n訂單:${MerchantTradeNo}\n時間:${PaymentDate}` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type:'text', text:
          `✅ 付款成功\n感謝 ${userName}\n金額:NT$ ${amount.toLocaleString()}\n綠界訂單:${MerchantTradeNo}` });
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

// ========== LINE Webhook（保持原本） ==========
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

// 用 Flex 傳「中文按鈕」：綠界信用卡 / LINE Pay
async function pushPaymentFlex(userId, userName, amount, ecpayLink, linepayEntryUrl, headerText) {
  const actions = [];
  if (ecpayLink) {
    actions.push({
      type: 'button',
      style: 'primary',
      color: '#52c41a',
      action: { type: 'uri', label: '綠界信用卡', uri: ecpayLink }
    });
  }
  if (linepayEntryUrl) {
    actions.push({
      type: 'button',
      style: 'primary',
      color: '#00c300',
      action: { type: 'uri', label: 'LINE Pay', uri: linepayEntryUrl }
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

// ========== 定時：每天 10:00 檢查（是否滿兩天 & 距上次提醒兩天） ==========
cron.schedule('0 10 * * *', async () => {
  try {
    const targets = orderManager.getOrdersNeedingReminder();
    for (const order of targets) {
      try {
        const linePay = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (!linePay.success) continue;

        // 更新付款資訊（保留同筆訂單）
        orderManager.updatePaymentInfo(order.orderId, linePay.transactionId, linePay.paymentUrl);

        // 兩個連結（LINE Pay 永久入口、綠界直接連）
        const entry = `${BASE_URL}/payment/linepay/pay/${order.orderId}`;
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
        logger.logToFile(`✅ 定時提醒：${order.orderId}`);
      } catch (e) {
        logger.logError('定時提醒單筆失敗', e);
      }
    }
  } catch (e) {
    logger.logError('定時提醒錯誤', e);
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