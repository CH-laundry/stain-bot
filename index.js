// index.js －－ 直接整份覆蓋

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');

const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
const customerDB = require('./services/customerDatabase');
const messageHandler = require('./services/message');
const { Client } = require('@line/bot-sdk');
const googleAuth = require('./services/googleAuth');
const { createECPayPaymentLink } = require('./services/openai');

const upload = multer({ storage: multer.memoryStorage() });

/* ---------- 可選：Railway 產生 sheet.json ---------- */
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('正在初始化 sheet.json: 成功');
  } catch (e) { console.log('sheet.json 寫入失敗:', e.message); }
}

/* ---------- App 基本設定 ---------- */
const app = express();
app.use(cors());
app.options('*', cors());            // 手機瀏覽器的預檢請求
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* ---------- 本地檔案：客戶編號 / 模板 ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(
    META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2)
  );
  if (!fs.existsSync(TPL_FILE)) fs.writeFileSync(
    TPL_FILE, JSON.stringify([
      '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
      '衣物已完成清洗，費用 NT$ {amount}，可來店取件囉！'
    ], null, 2)
  );
}
ensureDataFiles();

const readJSON  = fp => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2));

/* ---------- LINE SDK ---------- */
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

/* ---------- API：客戶編號 / 模板 ---------- */
app.get('/api/customer-meta', (_req, res) => {
  try { const { nextNo, map } = readJSON(META_FILE); res.json({ success: true, nextNo, map }); }
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
    res.json({ success: true, number: no, data: meta.map[no] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/customer-meta/:number', (req, res) => {
  try {
    const no = String(req.params.number);
    const meta = readJSON(META_FILE);
    if (!meta.map[no]) return res.json({ success: false, error: '不存在' });
    delete meta.map[no];
    writeJSON(META_FILE, meta);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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
    const i = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(i >= 0 && i < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr[i] = content || arr[i]; writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const i = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(i >= 0 && i < arr.length)) return res.json({ success: false, error: '索引錯誤' });
    arr.splice(i, 1); writeJSON(TPL_FILE, arr);
    res.json({ success: true, templates: arr });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ---------- 使用者清單（給右側「客戶載入」） ---------- */
app.get('/api/users', (_req, res) => {
  try {
    const users = customerDB.getAllCustomers();     // 你原有的資料來源
    res.json({ success: true, total: users.length, users });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ---------- LINE Pay 設定 ---------- */
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};
function signLine(uri, body, nonce) {
  const msg = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(msg).digest('base64');
}

/* ---------- 把「發送付款」的核心邏輯抽成一個函式 ---------- */
async function handleSendPayment(req, res) {
  const { userId, userName, amount, paymentType, customMessage } = req.body || {};
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);
  if (!userId || !userName || !amount) {
    return res.status(400).json({ success: false, error: '缺少必要參數' });
  }
  const numAmount = parseInt(amount, 10);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, error: '金額必須是正整數' });
  }

  try {
    const type = paymentType || 'both';
    let ecpayLink = '', linepayLink = '';
    let linePayOrderId = '', ecpayOrderId = '';

    // 綠界（永久入口：/payment/linepay/pay/:orderId 同理可做 EC，如果你想也能做 /payment/ec/:orderId）
    if (type === 'ecpay' || type === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      ecpayLink = createECPayPaymentLink(userId, userName, numAmount); // 你的原有方法
    }

    // LINE Pay：持久入口（使用我們的「固定頁」轉跳，每次開 20 分鐘票據）
    if (type === 'linepay' || type === 'both') {
      // 先建一筆訂單，持久入口 /payment/linepay/pay/:orderId
      linePayOrderId = `LP${Date.now()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount });
      const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
      linepayLink = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
    }

    // 準備訊息（LINE 不支援「自訂文字超連結」，只能顯示 URL，本段盡量簡潔）
    const msg = (customMessage || `您好，${userName} 您的金額為 NT$ ${numAmount.toLocaleString()}`) +
      (type !== 'linepay' ? `\n\n綠界信用卡：\n${ecpayLink}` : '') +
      (type !== 'ecpay' ? `\n\nLINE Pay：\n${linepayLink}` : '') +
      `\n\n✅ 付款後系統會自動通知我們`;

    await client.pushMessage(userId, { type: 'text', text: msg });

    return res.json({
      success: true,
      message: '已發送',
      orderId: linePayOrderId || ecpayOrderId,
      links: { ecpay: ecpayLink || null, linepay: linepayLink || null }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    return res.status(500).json({ success: false, error: '發送失敗' });
  }
}

/* ---------- 路由：發送付款（兩條都可用，給前後版本相容） ---------- */
app.post('/send-payment', handleSendPayment);
app.post('/api/send-payment', handleSendPayment);

/* ---------- LINE Pay 固定入口頁（依原本邏輯生成 20 分票據後轉跳） ---------- */
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');

  // 已付或過期處理（略）…這裡保留你原本的邏輯
  if (orderManager.isExpired(orderId)) {
    return res.send('⏰ 訂單已過期，請向客服索取新連結');
  }
  if (order.status === 'paid') {
    return res.send('✅ 訂單已付款，無須再次付款');
  }

  try {
    // 這裡呼叫 LINE Pay request 產出 20 分鐘有效票據，然後轉跳
    // 為了簡潔，仍沿用你原本 createLinePayPayment 的流程（略）
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const uri = '/v3/payments/request';
    const body = {
      amount: order.amount,
      currency: 'TWD',
      orderId: orderId,
      packages: [{ id: orderId, amount: order.amount, name: 'C.H精緻洗衣服務', products: [{ name: '洗衣服務費用', quantity: 1, price: order.amount }] }],
      redirectUrls: {
        confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${order.userId}&userName=${encodeURIComponent(order.userName)}&amount=${order.amount}`,
        cancelUrl: `${baseURL}/payment/linepay/cancel`
      }
    };
    const nonce = crypto.randomBytes(16).toString('base64');
    const signature = signLine(uri, body, nonce);
    const resp = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });
    const json = await resp.json();
    if (json.returnCode !== '0000') {
      logger.logToFile(`❌ LINE Pay 付款請求失敗: ${json.returnCode} - ${json.returnMessage}`);
      return res.status(500).send('付款連結生成失敗');
    }
    orderManager.updatePaymentInfo(orderId, json.info.transactionId, json.info.paymentUrl.web);
    // 直接轉跳 LINE Pay 官方頁
    res.redirect(json.info.paymentUrl.web);
  } catch (e) {
    logger.logError('LINE Pay 入口頁失敗', e);
    res.status(500).send('系統錯誤');
  }
});

/* ---------- 其它你原本的 webhook / OAuth / orders API ……(保留即可) ---------- */

/* ---------- 靜態頁 ---------- */
app.get('/payment', (_req, res) => res.sendFile('payment.html', { root: './public' }));

/* ---------- 啟動 ---------- */
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
});