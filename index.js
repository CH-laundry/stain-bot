// ===== 基本相依 =====
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// ===== 你現有服務 =====
const logger = require('./services/logger');
const customerDB = require('./services/customerDatabase');
const orderManager = require('./services/orderManager');
const messageHandler = require('./services/message');
const googleAuth = require('./services/googleAuth');

// 綠界付款連結產生器（你原本就有的）
const { createECPayPaymentLink } = require('./services/openai');

// ===== LINE Bot SDK =====
const { Client } = require('@line/bot-sdk');
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ====== 管理者推播對象（已預設為你提供的 userId）======
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'U5099169723d6e83588c5f23dfaf6f9cf';

// ===== App & 中介層 =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ====== 資料檔（客戶編號 / 模板）======
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

(function ensureDataFiles(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  if (!fs.existsSync(TPL_FILE))  fs.writeFileSync(TPL_FILE, JSON.stringify([
    '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
    '本次服務費用 NT$ {amount}，謝謝支持！',
    '已完成處理，費用 NT$ {amount}，可來店取件喔！'
  ], null, 2));
})();
const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2));

// ====== LINE Pay 參數 ======
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

// ====== 工具 ======
function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// 產生 LINE Pay request（不直接回傳長連結，之後用「持久入口」/payment/linepay/pay/:orderId）
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
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

// ====== 讓 LINE 訊息用中文「按鈕」，不露出長網址 ======
function buildTwoButtonTemplate(text, ecpayUrl, linepayUrl) {
  return {
    type: 'template',
    altText: '付款連結',
    template: {
      type: 'buttons',
      title: '付款方式',
      text: text || '請選擇付款方式',
      actions: [
        { type: 'uri', label: '綠界信用卡', uri: ecpayUrl },
        { type: 'uri', label: 'LINE Pay',   uri: linepayUrl }
      ]
    }
  };
}

// ====== 客戶資料：記錄 LINE 使用者（被動）======
async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (error) {
    logger.logError('記錄用戶資料失敗', error, userId);
  }
}

// ====== API：客戶清單（給前端右側「客戶載入」）======
app.get('/api/users', (_req, res) => {
  const users = customerDB.getAllCustomers(); // { userId, name }
  res.json({ success: true, total: users.length, users });
});

// ====== API：客戶編號（同步 + 儲存）======
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success: false, error: '缺少 name 或 userId' });
    const meta = readJSON(META_FILE);
    // 若 number 無或重複，分配新的
    let no = number ? String(number) : String(meta.nextNo++);
    if (meta.map[no] && (meta.map[no].userId !== userId || meta.map[no].name !== name)) {
      no = String(meta.nextNo++); // 避免覆蓋，給新號碼
    }
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/customer-meta/:number', (req, res) => {
  try {
    const meta = readJSON(META_FILE);
    const no = String(req.params.number);
    if (!meta.map[no]) return res.json({ success: false, error: '不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====== API：訊息模板 ======
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

// ====== 訂單 API（列表 / 統計 / 續約 / 刪除）======
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  let orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const now = Date.now();
  const ordersWithStatus = orders.map(o => ({
    ...o,
    isExpired: now > o.expiryTime,
    remainingTime: Math.max(0, o.expiryTime - now),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - now) / (1000 * 60 * 60))
  }));
  res.json({ success: true, total: ordersWithStatus.length, orders: ordersWithStatus, statistics: orderManager.getStatistics() });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    // 產生 LINE Pay 單次連結（供立即跳轉），但聊天訊息使用持久入口
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) return res.status(500).json({ success: false, error: '重新生成 LINE Pay 連結失敗' });
    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    // 持久入口（永不失效）：再次點開就會幫你產生 20 分鐘的官方頁
    const linepayEntry = `${BASE_URL}/payment/linepay/pay/${orderId}`;

    // 綠界：用 redirect 路徑封裝 form POST，網址雖長，但我們用「按鈕」包起來
    const ecpayRaw = createECPayPaymentLink(order.userId, order.userName, order.amount); // 取得 form 參數字串
    const redirectUrl = `${BASE_URL}/payment/redirect?data=${encodeURIComponent(Buffer.from(JSON.stringify(ecpayRaw)).toString('base64'))}`;

    // 用中文按鈕推送
    await client.pushMessage(order.userId, buildTwoButtonTemplate(
      `訂單編號：${orderId}\n金額：NT$ ${order.amount.toLocaleString()}\n請選擇付款方式：`,
      redirectUrl,
      linepayEntry
    ));

    orderManager.markReminderSent(orderId);
    logger.logToFile(`✅ 續約重發（按鈕訊息）：${orderId}`);
    res.json({ success: true, message: '已續約並重新發送付款連結（按鈕訊息）' });
  } catch (e) {
    logger.logError('續約訂單失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const deleted = orderManager.deleteOrder(req.params.orderId);
  if (deleted) res.json({ success: true, message: '訂單已刪除' });
  else res.status(404).json({ success: false, error: '找不到此訂單' });
});

app.post('/api/orders/send-reminders', async (_req, res) => {
  const list = orderManager.getOrdersNeedingReminder();
  if (list.length === 0) return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });

  let sent = 0;
  for (const order of list) {
    try {
      const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!linePayResult.success) continue;

      // 建新 LINE Pay 訂單，刪舊單（沿用你既有策略）
      orderManager.createOrder(linePayResult.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
      orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      orderManager.deleteOrder(order.orderId);

      const linepayEntry = `${BASE_URL}/payment/linepay/pay/${linePayResult.orderId}`;

      const ecpayRaw = createECPayPaymentLink(order.userId, order.userName, order.amount);
      const redirectUrl = `${BASE_URL}/payment/redirect?data=${encodeURIComponent(Buffer.from(JSON.stringify(ecpayRaw)).toString('base64'))}`;

      await client.pushMessage(order.userId, buildTwoButtonTemplate(
        `付款提醒：金額 NT$ ${order.amount.toLocaleString()}`,
        redirectUrl,
        linepayEntry
      ));
      orderManager.markReminderSent(linePayResult.orderId);
      sent++;
    } catch (e) {
      logger.logError('發送提醒失敗', e);
    }
  }
  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent });
});

// ====== 送付款（前端按「發送付款連結」）======
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body || {};
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);

  if (!userId || !userName || !amount) {
    return res.status(400).json({ success: false, error: '缺少必要參數' });
  }
  const numAmount = parseInt(amount, 10);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, error: '金額必須是正整數' });
  }

  try {
    const type = paymentType || 'both';
    let ecpayUrl = null;
    let linepayEntryUrl = null;

    // 綠界：建立訂單（為了後台統計）；實際付款用 redirect 封裝
    if (type === 'ecpay' || type === 'both') {
      const ecId = `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      orderManager.createOrder(ecId, { userId, userName, amount: numAmount });
      const ecpayRaw = createECPayPaymentLink(userId, userName, numAmount);
      ecpayUrl = `${BASE_URL}/payment/redirect?data=${encodeURIComponent(Buffer.from(JSON.stringify(ecpayRaw)).toString('base64'))}`;
    }

    // LINE Pay：產一次 request（存交易 id），聊天給「持久入口」
    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);
      if (linePayResult.success) {
        orderManager.createOrder(linePayResult.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        linepayEntryUrl = `${BASE_URL}/payment/linepay/pay/${linePayResult.orderId}`;
      }
    }

    // 組文字（出現在按鈕上方）
    const topText = (customMessage || `金額 NT$ ${numAmount.toLocaleString()}，請選擇付款方式：`).replace('{amount}', numAmount.toLocaleString());

    // 推中文「按鈕」訊息
    if (type === 'both' && ecpayUrl && linepayEntryUrl) {
      await client.pushMessage(userId, buildTwoButtonTemplate(topText, ecpayUrl, linepayEntryUrl));
    } else if (type === 'ecpay' && ecpayUrl) {
      await client.pushMessage(userId, buildTwoButtonTemplate(topText, ecpayUrl, 'https://line.me/R/'));
    } else if (type === 'linepay' && linepayEntryUrl) {
      await client.pushMessage(userId, buildTwoButtonTemplate(topText, 'https://payment.ecpay.com.tw', linepayEntryUrl));
    } else {
      return res.status(500).json({ success: false, error: '付款連結生成失敗' });
    }

    logger.logToFile(`✅ 已發送付款連結（按鈕訊息）：${userName} - ${numAmount} (${type})`);
    res.json({ success: true });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ success: false, error: '發送失敗' });
  }
});

// ====== LINE Webhook（保留你原有的處理）======
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
      } catch (e) {
        logger.logError('處理事件時出錯', e, event.source?.userId);
      }
    }
  } catch (e) {
    logger.logError('Webhook 全局錯誤', e);
  }
});

// ====== Google OAuth/測試（原本就有的，略維持）======
app.get('/auth/status', (_req, res) => {
  const isAuthorized = googleAuth.isAuthorized();
  res.json({ authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

// ====== 付款頁（持久入口 & 轉跳）======
// 1) 封裝 ECPay 表單 POST 的 redirect（長參數藏起來）
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');

  try {
    const payload = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    // payload 是 createECPayPaymentLink 的回傳欄位物件
    const form = `
<!doctype html><meta charset="utf-8">
<title>前往綠界付款</title>
<style>body{font-family:system-ui;padding:40px;text-align:center}</style>
<h3>正在跳轉到綠界付款頁面...</h3>
<form id="F" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">
${Object.keys(payload).map(k => `<input type="hidden" name="${k}" value="${payload[k]}">`).join('\n')}
<button type="submit">前往綠界付款</button></form>
<script>setTimeout(()=>document.getElementById('F').submit(),500)</script>`;
    res.send(form);
  } catch (e) {
    logger.logError('付款跳轉失敗', e);
    res.status(500).send('付款連結錯誤');
  }
});

// 2) LINE Pay「持久入口」：每次打開替你向 LINE Pay 申請 20 分鐘有效頁
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');

  if (orderManager.isExpired(orderId)) {
    const hours = ((Date.now() - order.createdAt) / 3600000) | 0;
    return res.send(`<h3>⏰ 訂單已過期（${hours} 小時）</h3>`);
  }
  if (order.status === 'paid') return res.send('<h3>✅ 此訂單已付款</h3>');

  try {
    const result = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!result.success) return res.status(500).send('付款連結生成失敗');

    orderManager.updatePaymentInfo(orderId, result.transactionId, result.paymentUrl);
    const remainingHours = Math.floor((order.expiryTime - Date.now()) / 3600000);
    res.send(`
<!doctype html><meta charset="utf-8">
<title>前往 LINE Pay</title>
<style>body{font-family:system-ui;padding:40px;text-align:center}</style>
<h2>💳 前往 LINE Pay 付款</h2>
<p>訂單：${orderId}</p>
<p>金額：NT$ ${order.amount.toLocaleString()}</p>
<p>剩餘有效時間：${remainingHours} 小時</p>
<a href="${result.paymentUrl}">立即前往 LINE Pay 付款</a>
<script>setTimeout(()=>location.href="${result.paymentUrl}",1500)</script>`);
  } catch (e) {
    logger.logError('重新生成 LINE Pay 連結失敗', e);
    res.status(500).send('系統錯誤');
  }
});

// 3) LINE Pay confirm：標記已付並「通知你（ADMIN_USER_ID）」與客戶
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);
  if (order && orderManager.isExpired(orderId)) return res.send('訂單已過期');

  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount, 10), currency: 'TWD' };
    const signature = generateLinePaySignature(uri, body, nonce);
    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    if (result.returnCode === '0000') {
      if (order) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');

      // 通知老闆（你）
      await client.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text:
          `🎉 收到 LINE Pay 付款\n` +
          `客戶：${decodeURIComponent(userName)}\n金額：NT$ ${parseInt(amount,10).toLocaleString()}\n` +
          `訂單：${orderId}\n交易：${transactionId}\n狀態：✅ 成功`
      });
      // 通知客戶
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text:
            `✅ 付款成功\n感謝 ${decodeURIComponent(userName)} 的支付\n` +
            `金額：NT$ ${parseInt(amount,10).toLocaleString()}\n訂單：${orderId}`
        });
      }
      res.redirect('/payment/success');
    } else {
      logger.logToFile(`❌ LINE Pay 確認失敗: ${result.returnMessage}`);
      res.status(400).send('付款確認失敗');
    }
  } catch (e) {
    logger.logError('LINE Pay 確認付款失敗', e);
    res.status(500).send('付款處理失敗');
  }
});

// ====== 綠界 callback（標記已付並通知你）======
app.post('/payment/ecpay/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { MerchantTradeNo, RtnCode, RtnMsg, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body;
    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt, 10);
      orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');

      // 通知老闆（你）
      await client.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text:
          `🎉 收到綠界付款\n客戶：${userName}\n金額：NT$ ${amount.toLocaleString()}\n` +
          `付款時間：${PaymentDate}\n商店訂單：${MerchantTradeNo}\n狀態：✅ 成功`
      });
      // 通知客戶
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text:
            `✅ 付款成功\n感謝 ${userName} 的支付\n金額：NT$ ${amount.toLocaleString()}\n` +
            `綠界訂單：${MerchantTradeNo}`
        });
      }
    } else {
      logger.logToFile(`❌ 綠界付款異常：${RtnMsg}`);
    }
    res.send('1|OK');
  } catch (e) {
    logger.logError('處理綠界回調失敗', e);
    res.send('0|ERROR');
  }
});

// ====== 其它小頁 ======
app.get('/payment/success', (_req, res) => res.send('<h2>✅ 付款已完成，感謝您的支持</h2>'));
app.get('/payment/linepay/cancel', (_req, res) => res.send('<h2>❌ 您已取消付款</h2>'));
app.get('/payment', (_req, res) => res.sendFile('payment.html', { root: './public' }));

// ====== 啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  logger.logToFile(`伺服器正在運行, 端口: ${PORT}`);
  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (e) {
    console.error('❌ 客戶資料載入失敗:', e.message);
  }
  // 每日清除過期
  setInterval(() => orderManager.cleanExpiredOrders(), 24 * 60 * 60 * 1000);
  // 每 12 小時自動提醒（按鈕訊息）
  setInterval(async () => {
    const list = orderManager.getOrdersNeedingReminder();
    for (const order of list) {
      try {
        const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (!linePayResult.success) continue;

        orderManager.createOrder(linePayResult.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        orderManager.deleteOrder(order.orderId);

        const entry = `${BASE_URL}/payment/linepay/pay/${linePayResult.orderId}`;
        const ecpayRaw = createECPayPaymentLink(order.userId, order.userName, order.amount);
        const redirect = `${BASE_URL}/payment/redirect?data=${encodeURIComponent(Buffer.from(JSON.stringify(ecpayRaw)).toString('base64'))}`;

        await client.pushMessage(order.userId, buildTwoButtonTemplate(
          `付款提醒：金額 NT$ ${order.amount.toLocaleString()}`,
          redirect,
          entry
        ));
        orderManager.markReminderSent(linePayResult.orderId);
      } catch (e) {
        logger.logError('自動提醒失敗', e);
      }
    }
  }, 12 * 60 * 60 * 1000);
});