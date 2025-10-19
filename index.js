// ===== index.js =====
/* eslint-disable no-console */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const logger = require('./services/logger');
const messageHandler = require('./services/message');
const { Client } = require('@line/bot-sdk');
const customerDB = require('./services/customerDatabase');
const orderManager = require('./services/orderManager');
const googleAuth = require('./services/googleAuth');
const { createECPayPaymentLink } = require('./services/openai'); // 綠界付款連結

// ---- 可選：環境有 GOOGLE_PRIVATE_KEY 就丟一份 sheet.json 給 OAuth 流程用 ----
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('正在初始化 sheet.json: 成功');
  } catch (e) {
    console.log('初始化 sheet.json 失敗', e.message);
  }
} else {
  console.log('跳過 sheet.json 初始化 (使用 OAuth 2.0)');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ====== LINE SDK ======
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ====== 資料檔：客戶編號 + 訊息模板（落地硬碟） ======
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');   // { nextNo: 1, map: { "625":{name,userId}, ... } }
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json'); // ["文字1","文字2",...]

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  }
  if (!fs.existsSync(TPL_FILE)) {
    fs.writeFileSync(
      TPL_FILE,
      JSON.stringify([
        '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
        '衣物已完成清洗，金額 NT$ {amount}，可付款取件。',
        '衣物處理中，預付金額 NT$ {amount}。',
        '訂金收訖 NT$ {amount}，感謝您的支持！',
      ], null, 2)
    );
  }
}
ensureDataFiles();

const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, v) => fs.writeFileSync(fp, JSON.stringify(v, null, 2));

// ====== API：客戶編號 ======
app.get('/api/customer-meta', (_req, res) => {
  try {
    res.json({ success: true, ...readJSON(META_FILE) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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

// ====== API：訊息模板 ======
app.get('/api/templates', (_req, res) => {
  try {
    res.json({ success: true, templates: readJSON(TPL_FILE) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success: false, error: '缺少 content' });
    const arr = readJSON(TPL_FILE);
    arr.push(content);
    writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr[idx] = content || arr[idx];
    writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr.splice(idx, 1);
    writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====== 客戶資料（舊模組 customerDB，保留給 /api/users 等使用） ======
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

app.put('/api/user/:userId/name', async (req, res) => {
  const { userId } = req.params;
  const { displayName } = req.body;
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: '名稱不能為空' });
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

// ====== LINE Pay ======
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me',
};

function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
    .update(message).digest('base64');
}

async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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
        products: [{ name: '洗衣服務費用', quantity: 1, price: amount }],
      }],
      redirectUrls: {
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
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
    if (result.returnCode === '0000') {
      logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
      return {
        success: true,
        paymentUrl: result.info.paymentUrl.web,
        orderId,
        transactionId: result.info.transactionId,
      };
    }
    logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
    return { success: false, error: result.returnMessage };
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

// ====== LINE Webhook（保留原本機器人邏輯） ======
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

// ====== OAuth / 測試頁（原樣保留） ======
app.get('/auth', (_req, res) => {
  try {
    const authUrl = googleAuth.getAuthUrl();
    console.log('生成授權 URL:', authUrl);
    res.redirect(authUrl);
  } catch (error) {
    logger.logError('生成授權 URL 失敗', error);
    res.status(500).send('授權失敗: ' + error.message);
  }
});

// 其餘 /oauth2callback、/test-sheets、/test-upload、/log、/test-push 與你現有版本一致
// ---（為了篇幅省略，如果你有需要我也能還原完整，但不影響付款流程）---

// ====== 前往綠界頁面的 redirect（保留） ======
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try {
    const paymentData = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const formHTML = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>跳轉到綠界付款</title>
<style>body{font-family:sans-serif;text-align:center;padding:50px}.loading{font-size:18px;color:#666}</style></head>
<body><h3 class="loading">正在跳轉到付款頁面...</h3><p>請稍候,若未自動跳轉請點擊下方按鈕</p>
<form id="ecpayForm" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">
${Object.keys(paymentData).map(k=>`<input type="hidden" name="${k}" value="${paymentData[k]}">`).join('\n')}
<button type="submit" style="padding:10px 20px;font-size:16px;cursor:pointer">前往付款</button></form>
<script>setTimeout(function(){document.getElementById('ecpayForm').submit()},500)</script></body></html>`;
    res.send(formHTML);
  } catch (e) {
    logger.logError('付款跳轉失敗', e);
    res.status(500).send('付款連結錯誤');
  }
});

app.get('/payment/success', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{font-size:32px}</style></head><body><h1>✅ 付款已完成</h1><p>感謝您的支付，我們會盡快處理您的訂單</p></body></html>');
});

app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款取消</title></head><body><h1>❌ 付款已取消</h1></body></html>');
});

// ====== 永久入口：/payment/linepay/pay/:orderId ======
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title></head><body><h1>❌ 訂單不存在</h1></body></html>');
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (${hoursPassed.toFixed(1)}h)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title></head><body><h1>⏰ 訂單已過期</h1></body></html>');
  }
  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>已付款</title></head><body><h1>✅ 訂單已付款</h1></body></html>');
  }
  try {
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!linePayResult.success) throw new Error(linePayResult.error || 'LINE Pay 生成失敗');
    orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);

    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    res.send(`
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往付款</title>
<style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}</style></head>
<body><h1>💳 前往 LINE Pay 付款</h1>
<p><strong>訂單編號:</strong> ${orderId}</p>
<p><strong>金額:</strong> NT$ ${order.amount.toLocaleString()}</p>
<p><strong>剩餘有效時間:</strong> ${remainingHours} 小時</p>
<p>連結開啟後 20 分鐘內有效，超時請回到這一頁重新取得。</p>
<a href="${linePayResult.paymentUrl}" style="display:inline-block;padding:14px 28px;background:#fff;color:#667eea;border-radius:10px;font-weight:bold;text-decoration:none">立即前往付款</a>
<script>setTimeout(function(){location.href='${linePayResult.paymentUrl}'},1500)</script>
</body></html>`);
  } catch (e) {
    logger.logError('重新生成 LINE Pay 連結失敗', e);
    res.status(500).send('系統錯誤');
  }
});

// ====== LINE Pay 付款確認（成功會標記所有該 userId 的單為 paid） ======
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);
  if (order && orderManager.isExpired(orderId)) {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title></head><body><h1>⏰ 訂單已過期</h1></body></html>');
  }
  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const requestBody = { amount: parseInt(amount, 10), currency: 'TWD' };
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
    if (result.returnCode === '0000') {
      if (order) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      logger.logToFile(`✅ LINE Pay 付款成功, 已標記 ${updated} 筆為已付款`);
      if (process.env.ADMIN_USER_ID) {
        await client.pushMessage(process.env.ADMIN_USER_ID, {
          type: 'text',
          text: `🎉 收到 LINE Pay 付款\n客戶:${decodeURIComponent(userName)}\n金額: NT$ ${Number(amount).toLocaleString()}\n訂單:${orderId}\n交易:${transactionId}\n狀態: ✅ 付款成功`,
        });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, {
          type: 'text',
          text: `✅ 付款成功\n感謝 ${decodeURIComponent(userName)}\n金額: NT$ ${Number(amount).toLocaleString()}\n訂單:${orderId}\n我們會盡快處理 💙`,
        });
      }
      res.redirect('/payment/success');
    } else {
      logger.logToFile(`❌ LINE Pay 付款確認失敗: ${result.returnMessage}`);
      res.send('付款失敗：' + result.returnMessage);
    }
  } catch (e) {
    logger.logError('LINE Pay 確認付款失敗', e);
    res.status(500).send('付款處理失敗');
  }
});

// ====== 訂單 API（列表、續約、提醒、清除等） ======
app.get('/api/orders', (_req, res) => {
  const orders = orderManager.getAllOrders();
  const withCalc = orders.map(o => ({
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / (1000 * 60 * 60)),
  }));
  res.json({ success: true, total: withCalc.length, orders: withCalc, statistics: orderManager.getStatistics() });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);

    // 短網址
    async function short(u) {
      try {
        const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(u));
        const t = await r.text();
        return (t && t.startsWith('http')) ? t : u;
      } catch { return u; }
    }
    const persistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;
    const linepayShort = await short(persistentUrl);
    ecpayLink = await short(ecpayLink);

    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      await client.pushMessage(order.userId, {
        type: 'text',
        text:
          `🔄 付款連結已重新生成\n` +
          `訂單: ${orderId}\n` +
          `金額: NT$ ${order.amount.toLocaleString()}\n\n` +
          `綠界信用卡：${ecpayLink}\n` +
          `LINE Pay：${linepayShort}\n\n` +
          `說明：LINE Pay 連結每次開啟 20 分鐘內有效；失效再點同一條即可。`,
      });
      orderManager.markReminderSent(orderId);
      res.json({ success: true, message: '已續約並重新發送', links: { ecpay: ecpayLink, linepay: linepayShort } });
    } else {
      res.status(500).json({ success: false, error: 'LINE Pay 重建失敗' });
    }
  } catch (e) {
    logger.logError('續約失敗', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (ok) res.json({ success: true, message: '訂單已刪除' });
  else res.status(404).json({ success: false, error: '找不到此訂單' });
});

// 批次提醒（兩天未付）
app.post('/api/orders/send-reminders', async (_req, res) => {
  const due = orderManager.getOrdersNeedingReminder();
  if (due.length === 0) return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });

  let sent = 0;
  const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

  // helper 短網址
  async function short(u) {
    try {
      const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(u));
      const t = await r.text();
      return (t && t.startsWith('http')) ? t : u;
    } catch { return u; }
  }

  for (const order of due) {
    try {
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (!lp.success) continue;

      // 新建新的 LINE Pay 單，刪舊單（保留舊邏輯）
      orderManager.createOrder(lp.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
      orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);
      orderManager.deleteOrder(order.orderId);

      const persistent = `${baseURL}/payment/linepay/pay/${lp.orderId}`;
      const linepayShort = await short(persistent);

      let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
      ecpayLink = await short(ecpayLink);

      await client.pushMessage(order.userId, {
        type: 'text',
        text:
          `😊 付款提醒\n` +
          `親愛的 ${order.userName} 您好，您仍有待付款項\n` +
          `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
          `綠界信用卡：${ecpayLink}\n` +
          `LINE Pay：${linepayShort}\n\n` +
          `說明：LINE Pay 連結每次開啟 20 分鐘內有效；失效再點同一條即可。`,
      });

      orderManager.markReminderSent(lp.orderId);
      sent++;
    } catch (e) {
      logger.logError('發送提醒失敗', e);
    }
  }
  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent });
});

// ====== 發送付款（一次處理綠界 + LINE Pay；任一付款成功都算成交） ======
app.post('/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) return res.status(400).json({ success: false, error: '缺少必要參數' });

    const numAmount = parseInt(amount, 10);
    if (!Number.isInteger(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: '金額必須是正整數' });
    }

    const type = paymentType || 'both';
    let ecpayLink = '';
    let linepayLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    // helper 短網址
    async function short(u) {
      try {
        const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(u));
        const t = await r.text();
        return (t && t.startsWith('http')) ? t : u;
      } catch { return u; }
    }

    // 綠界
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      ecpayLink = await short(createECPayPaymentLink(userId, userName, numAmount));
      logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);
    }

    // LINE Pay（提供「永久入口」）
    if (type === 'linepay' || type === 'both') {
      const lp = await createLinePayPayment(userId, userName, numAmount);
      if (lp.success) {
        linePayOrderId = lp.orderId;
        orderManager.createOrder(lp.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(lp.orderId, lp.transactionId, lp.paymentUrl);

        const persistent = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app'}/payment/linepay/pay/${lp.orderId}`;
        linepayLink = await short(persistent);
        logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linePayOrderId}`);
      } else {
        logger.logToFile('❌ LINE Pay 付款請求失敗');
      }
    }

    // 組訊息（中文標籤 + 短網址）
    const msg = [];
    if (customMessage) msg.push(customMessage);
    if (type === 'both') {
      if (ecpayLink)   msg.push(`綠界信用卡：${ecpayLink}`);
      if (linepayLink) msg.push(`LINE Pay：${linepayLink}`);
    } else if (type === 'ecpay' && ecpayLink) {
      msg.push(`綠界信用卡：${ecpayLink}`);
    } else if (type === 'linepay' && linepayLink) {
      msg.push(`LINE Pay：${linepayLink}`);
    }
    msg.push('✅ 付款後系統會自動通知我們，謝謝您');

    await client.pushMessage(userId, { type: 'text', text: msg.join('\n\n') });

    res.json({
      success: true,
      message: '付款連結已發送',
      data: {
        userId, userName, amount: numAmount, paymentType: type,
        ecpayLink: ecpayLink || null, linepayLink: linepayLink || null,
        ecpayOrderId: ecpayOrderId || null, linePayOrderId: linePayOrderId || null,
        customMessage: customMessage || '',
      },
    });
  } catch (e) {
    logger.logError('發送付款連結失敗', e);
    res.status(500).json({ success: false, error: '發送失敗' });
  }
});

// ====== 簡單付款狀態查詢（占位） ======
app.get('/payment/status/:orderId', (req, res) => {
  res.json({ message: '付款狀態查詢功能(待實作)', orderId: req.params.orderId });
});

// ====== setInterval 版「每天 10:30 / 18:30 自動提醒」（台北時間） ======
(function bootstrapScheduler() {
  const tz = 'Asia/Taipei';
  let lastFireTag = null;

  function nowInTZ(date = new Date()) {
    // 取台北時間的各欄位（避免時區誤差）
    const f = new Intl.DateTimeFormat('zh-TW', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const tag = `${f.year}${f.month}${f.day}-${f.hour}:${f.minute}`;
    return { tag, hour: Number(f.hour), minute: Number(f.minute) };
  }

  async function tick() {
    try {
      const { tag, hour, minute } = nowInTZ();
      const isHit = (hour === 10 && minute === 30) || (hour === 18 && minute === 30);
      if (isHit && lastFireTag !== tag) {
        lastFireTag = tag;
        const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app'}/api/orders/send-reminders`;
        const r = await fetch(url, { method: 'POST' });
        const d = await r.json().catch(() => ({ success: false }));
        logger.logToFile(`⏰ Scheduler 觸發提醒：${JSON.stringify(d)}`);
      }
    } catch (e) {
      logger.logError('Scheduler 觸發失敗', e);
    }
  }
  setInterval(tick, 20 * 1000); // 每 20 秒檢查一次
})();

// ====== 監聽 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器正在運行, 端口:${PORT}`);
  logger.logToFile(`伺服器正在運行, 端口:${PORT}`);
  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (e) {
    console.error('❌ 客戶資料載入失敗:', e.message);
  }
  // 每日清過期
  setInterval(() => { orderManager.cleanExpiredOrders(); }, 24 * 60 * 60 * 1000);
});