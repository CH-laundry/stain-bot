// index.js — C.H 精緻洗衣付款系統（含永久入口 + 自動提醒 + 後台 API）
// --------------------------------------------------------------
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const fetch = require('node-fetch'); // v2
const crypto = require('crypto');
const cron = require('node-cron');
const { Client } = require('@line/bot-sdk');

// 你的現有服務
const orderManager = require('./services/orderManager');
const customerDB = require('./services/customerDatabase');
const logger = require('./services/logger');
// 綠界連結產生器（你原本放在 services/openai.js 的 createECPayPaymentLink）
const { createECPayPaymentLink } = require('./services/openai');

// ---------------- 基本設定 ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 靜態網站（付款後台頁面）
// 確保有 public 目錄，內有 payment.html
app.use(express.static(path.join(__dirname, 'public')));

// 進入點：/ → /payment
app.get('/', (_req, res) => {
  res.redirect('/payment');
});

// Health check
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// 明確提供 /payment（若用 SPA/靜態頁）
app.get('/payment', (req, res) => {
  res.sendFile('payment.html', { root: path.join(__dirname, 'public') });
});

// ---------------- LINE Bot Client ----------------
const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ---------------- 常用工具 ----------------
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(
      META_FILE,
      JSON.stringify({ nextNo: 1, map: {} }, null, 2),
      'utf8'
    );
  }
  if (!fs.existsSync(TPL_FILE)) {
    fs.writeFileSync(
      TPL_FILE,
      JSON.stringify([
        '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
        '衣物已完成清洗，金額 NT$ {amount}，可付款取件。',
        '衣物處理中，預付金額 NT$ {amount}。'
      ], null, 2),
      'utf8'
    );
  }
}
ensureDataFiles();

const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8');

// 短網址（盡量美化；失敗就用原始網址）
async function tryShort(url) {
  try {
    const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    const t = await r.text();
    if (t && /^https?:\/\//i.test(t)) return t;
  } catch {}
  return url;
}

// ---------------- LINE Pay 設定 ----------------
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: (process.env.LINE_PAY_ENV === 'sandbox')
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me',
};

function signLinePay(uri, body, nonce) {
  const msg = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
    .update(msg)
    .digest('base64');
}

// 建立一次性的 LINE Pay 支付請求（我們會把入口包成 /payment/linepay/pay/:orderId 的「持久入口」）
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://example.com';
    const body = {
      amount,
      currency: 'TWD',
      orderId,
      packages: [{
        id: orderId,
        amount,
        name: 'C.H 精緻洗衣服務',
        products: [{ name: '洗衣服務費用', quantity: 1, price: amount }]
      }],
      redirectUrls: {
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel`
      }
    };
    const uri = '/v3/payments/request';
    const signature = signLinePay(uri, body, nonce);

    const res = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });
    const result = await res.json();
    if (result.returnCode === '0000') {
      logger.logToFile(`✅ LINE Pay 請求成功: ${orderId}`);
      return {
        success: true,
        orderId,
        transactionId: result.info.transactionId,
        paymentUrl: result.info.paymentUrl?.web
      };
    }
    logger.logToFile(`❌ LINE Pay 失敗: ${result.returnCode} ${result.returnMessage}`);
    return { success: false, error: result.returnMessage || 'LINE Pay 失敗' };
  } catch (e) {
    logger.logError('LINE Pay 請求錯誤', e);
    return { success: false, error: e.message };
  }
}

// ---------------- Webhook（可保留你原來的訊息機制） ----------------
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      try {
        if (ev.type !== 'message' || !ev.source?.userId) continue;
        const userId = ev.source.userId;
        // 保存使用者資料（你現有 customerDB）
        try {
          const profile = await lineClient.getProfile(userId);
          await customerDB.saveCustomer(userId, profile.displayName);
        } catch {}
        // 這裡可調用你現有 messageHandler...
      } catch (err) {
        logger.logError('處理單一事件失敗', err);
      }
    }
  } catch (err) {
    logger.logError('Webhook 全局錯誤', err);
  }
});

// ---------------- 客戶編號 API ----------------
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/customer-meta/save', (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success:false, error:'缺少 name 或 userId' });
    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success:true, number:no, data:meta.map[no] });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/customer-meta/:number', (req, res) => {
  try {
    const no = String(req.params.number);
    const meta = readJSON(META_FILE);
    if (!meta.map[no]) return res.json({ success:false, error:'不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// ---------------- 模板 API ----------------
app.get('/api/templates', (_req, res) => {
  try { res.json({ success:true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE);
    arr.push(content);
    writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.put('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr[idx] = content || arr[idx];
    writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(idx, 1);
    writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// ---------------- 使用者清單（給前端客戶載入） ----------------
app.get('/api/users', (_req, res) => {
  const users = customerDB.getAllCustomers(); // 你現有的 service
  res.json({ success: true, total: users.length, users });
});

// ---------------- 訂單 API ----------------
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  const list = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const enhanced = list.map(o => ({
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / 36e5)
  }));
  res.json({ success:true, total: enhanced.length, orders: enhanced, statistics: orderManager.getStatistics() });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  try {
    // 產生新的 LINE Pay 支付頁（每次開啟 20 分鐘有效）
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) return res.status(500).json({ success:false, error:'重新生成 LINE Pay 失敗' });

    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    // 永久入口（持久 URL）
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://example.com';
    const lineEntry = `${baseURL}/payment/linepay/pay/${orderId}`;
    let prettyLine = await tryShort(lineEntry);

    // 綠界連結
    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    let prettyEcpay = await tryShort(ecpayLink);

    await lineClient.pushMessage(order.userId, {
      type: 'text',
      text:
        `🔄 付款連結已重新生成\n\n` +
        `訂單編號：${orderId}\n金額：NT$ ${order.amount.toLocaleString()}\n\n` +
        `綠界信用卡：\n${prettyEcpay}\n\n` +
        `LINE Pay：\n${prettyLine}\n\n` +
        `備註：LINE Pay 官方頁每次開啟 20 分鐘內有效；過時回來點同一條「LINE Pay」即可重新產生。`
    });

    orderManager.markReminderSent(orderId);
    res.json({ success:true, order, links: { ecpay: prettyEcpay, linepay: prettyLine } });
  } catch (e) {
    logger.logError('續約重發失敗', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  res.status(ok ? 200 : 404).json(ok ? { success:true } : { success:false, error:'找不到此訂單' });
});

app.post('/api/orders/clean-expired', (_req, res) => {
  const n = orderManager.cleanExpiredOrders();
  res.json({ success:true, cleaned: n });
});

// ---------------- 付款入口頁（永久入口） ----------------
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');

  if (orderManager.isExpired(orderId)) {
    return res.status(410).send('訂單已過期，請向客服重新取得連結');
  }
  if (order.status === 'paid') {
    return res.send('此訂單已付款，感謝您！');
  }
  try {
    const r = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!r.success) return res.status(500).send('生成 LINE Pay 失敗，請稍後再試');
    orderManager.updatePaymentInfo(orderId, r.transactionId, r.paymentUrl);

    // 2 秒後自動導向
    res.send(
      `<!doctype html><meta charset="utf-8"><title>前往 LINE Pay</title>
       <p>訂單編號：${orderId}</p>
       <p>金額：NT$ ${order.amount.toLocaleString()}</p>
       <p>將前往 LINE Pay 付款頁…</p>
       <p><a href="${r.paymentUrl}">若未自動前往，請點此</a></p>
       <script>setTimeout(function(){location.href=${JSON.stringify(r.paymentUrl)}},1500)</script>`
    );
  } catch (e) {
    logger.logError('持久入口產生連結失敗', e);
    res.status(500).send('系統錯誤');
  }
});

// 付款成功確認（LINE Pay）
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount, 10), currency: 'TWD' };
    const signature = signLinePay(uri, body, nonce);
    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.returnCode === '0000') {
      if (orderId) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      // 再補保險：同 userId 全部 pending 標為 paid
      if (userId) orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');

      // 通知管理員
      if (process.env.ADMIN_USER_ID) {
        await lineClient.pushMessage(process.env.ADMIN_USER_ID, {
          type: 'text',
          text:
            `🎉 LINE Pay 付款成功\n\n` +
            `客戶：${decodeURIComponent(userName||'')}\n` +
            `金額：NT$ ${parseInt(amount,10).toLocaleString()}\n` +
            `訂單：${orderId}\n交易：${transactionId}`
        });
      }
      // 通知客戶
      if (userId) {
        await lineClient.pushMessage(userId, {
          type: 'text',
          text:
            `✅ 付款成功\n金額：NT$ ${parseInt(amount,10).toLocaleString()}\n` +
            `訂單編號：${orderId}\n感謝您的支持！`
        });
      }
      res.redirect('/payment/success');
    } else {
      res.status(400).send(`付款確認失敗：${j.returnMessage || j.returnCode}`);
    }
  } catch (e) {
    logger.logError('LINE Pay 確認錯誤', e);
    res.status(500).send('付款處理失敗');
  }
});

app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('您已取消此次付款');
});

// 綠界跳轉（把加簽後的表單資料帶到官方收銀台）
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try {
    const form = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const inputs = Object.keys(form)
      .map(k => `<input type="hidden" name="${k}" value="${String(form[k]).replace(/"/g,'&quot;')}">`)
      .join('');
    res.send(
      `<!doctype html><meta charset="utf-8"><title>跳轉到綠界付款</title>
       <p>前往綠界收銀台…</p>
       <form id="f" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">
         ${inputs}
       </form>
       <script>setTimeout(function(){document.getElementById('f').submit()},300)</script>`
    );
  } catch {
    res.status(400).send('付款資料格式錯誤');
  }
});

// ---------------- 發送付款（同時支援 /send-payment 與 /api/send-payment） ----------------
async function sendPaymentHandler(req, res) {
  const { userId, userName, amount, paymentType, customMessage } = req.body || {};
  if (!userId || !userName || !amount) {
    return res.status(400).json({ success:false, error:'缺少必要參數 userId/userName/amount' });
  }
  const numAmount = parseInt(amount, 10);
  if (!Number.isInteger(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success:false, error:'金額必須為正整數' });
  }

  const type = paymentType || 'both';
  let ecpayLink = null, lineEntryUrl = null;
  let ecpayOrderId = null, linePayOrderId = null;

  try {
    // 綠界
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).slice(2,7).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      let raw = createECPayPaymentLink(userId, userName, numAmount);
      ecpayLink = await tryShort(raw);
    }

    // LINE Pay（建立持久入口，不直接丟官方 20 分鐘 URL）
    if (type === 'linepay' || type === 'both') {
      const lp = await createLinePayPayment(userId, userName, numAmount);
      if (lp.success) {
        linePayOrderId = lp.orderId;
        orderManager.createOrder(lp.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);
        const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://example.com';
        const persistent = `${baseURL}/payment/linepay/pay/${lp.orderId}`;
        lineEntryUrl = await tryShort(persistent);
      } else {
        logger.logToFile(`❌ LINE Pay 生成失敗：${lp.error}`);
      }
    }

    // 組訊息（中文標題，連結美化）
    const msgParts = [];
    if (customMessage) msgParts.push(customMessage.replace('{amount}', numAmount.toLocaleString()));
    if (ecpayLink)   msgParts.push(`綠界信用卡：\n${ecpayLink}`);
    if (lineEntryUrl) msgParts.push(`LINE Pay：\n${lineEntryUrl}`);
    msgParts.push('✅ 付款後系統會自動通知我們，感謝您的支持。');

    await lineClient.pushMessage(userId, { type: 'text', text: msgParts.join('\n\n') });

    return res.json({
      success: true,
      data: {
        userId, userName, amount: numAmount, paymentType: type,
        ecpayLink: ecpayLink || null, linepayLink: lineEntryUrl || null,
        ecpayOrderId: ecpayOrderId || null, linePayOrderId: linePayOrderId || null,
        customMessage: customMessage || ''
      }
    });
  } catch (e) {
    logger.logError('發送付款連結失敗', e);
    res.status(500).json({ success:false, error: e.message || '發送失敗' });
  }
}

app.post('/send-payment', sendPaymentHandler);
app.post('/api/send-payment', sendPaymentHandler); // 兼容舊前端

// ---------------- 排程：自動提醒 / 清理 ----------------
// Asia/Taipei 時區（Railway 基礎容器 UTC，這裡用 cron 的時區選項）
// 每天 10:00 提醒未付款至少 2 天的訂單
cron.schedule('0 10 * * *', async () => {
  try {
    const list = orderManager.getOrdersNeedingReminder();
    if (!list.length) return;

    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://example.com';

    for (const order of list) {
      try {
        // 重新產生 LINE Pay（為了保證點進去能用）
        const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (!lp.success) continue;

        // 建檔（沿用舊行為：新 LINE Pay 新單，刪舊單）
        orderManager.createOrder(lp.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
        orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);
        orderManager.deleteOrder(order.orderId);

        const persistent = `${baseURL}/payment/linepay/pay/${lp.orderId}`;
        let lineShort = await tryShort(persistent);

        let ecpay = createECPayPaymentLink(order.userId, order.userName, order.amount);
        let ecpayShort = await tryShort(ecpay);

        await lineClient.pushMessage(order.userId, {
          type: 'text',
          text:
            `⏰ 溫馨提醒（未付款）\n\n` +
            `親愛的 ${order.userName} 您好，仍有一筆費用待支付：\n` +
            `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
            `綠界信用卡：\n${ecpayShort}\n\n` +
            `LINE Pay：\n${lineShort}\n\n` +
            `備註：LINE Pay 官方頁每次開啟 20 分鐘內有效；過時回來點同一條「LINE Pay」即可。`
        });

        orderManager.markReminderSent(lp.orderId);
      } catch (err) {
        logger.logError('排程提醒單筆失敗', err);
      }
    }
    logger.logToFile(`✅ 排程提醒完成，共處理 ${list.length} 筆`);
  } catch (e) {
    logger.logError('排程提醒失敗', e);
  }
}, { timezone: 'Asia/Taipei' });

// 每天 03:15 清理過期訂單
cron.schedule('15 3 * * *', () => {
  try {
    const n = orderManager.cleanExpiredOrders();
    logger.logToFile(`🧹 每日清理過期訂單：${n} 筆`);
  } catch (e) {
    logger.logError('每日清理失敗', e);
  }
}, { timezone: 'Asia/Taipei' });

// ---------------- 啟動 ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  logger.logToFile(`伺服器啟動：${PORT}`);
  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (e) {
    console.error('❌ 客戶資料載入失敗：', e.message);
  }
});