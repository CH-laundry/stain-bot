/**
 * index.js — C.H 精緻洗衣 後端主程式（可直接覆蓋）
 * 功能：
 *  - 公用靜態頁面 /public
 *  - 客戶編號 & 模板 讀寫至 /data
 *  - 發送付款（綠界 + LINE Pay），訊息用 Flex Message「中文按鈕」
 *  - 訂單管理 API（renew / remind / clean 等）
 *  - 兩天未付自動提醒（每天 10:30/18:30 台北時間）
 *  - LINE Pay 確認、綠界回傳 → 標記已付並通知管理者 + 客戶
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const multer = require('multer');
const cron = require('node-cron');

const logger = require('./services/logger');
const messageHandler = require('./services/message');
const { Client } = require('@line/bot-sdk');
const googleAuth = require('./services/googleAuth');
const customerDB = require('./services/customerDatabase');
const orderManager = require('./services/orderManager');
const { createECPayPaymentLink } = require('./services/openai'); // 產生綠界連結
const upload = multer({ storage: multer.memoryStorage() });

/* ---------- Google private key（若存在環境變數就落地 sheet.json） ---------- */
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('正在初始化 sheet.json: 成功');
  } catch (e) {
    console.log('初始化 sheet.json 失敗：', e.message);
  }
} else {
  console.log('跳過 sheet.json 初始化 (使用 OAuth 2.0)');
}

/* ---------- App 基本 ---------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* ---------- 本地持久化資料（客戶編號 & 模板） ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');      // { nextNo:number, map:{ [no]: {name,userId} } }
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');  // string[]

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  if (!fs.existsSync(TPL_FILE))  fs.writeFileSync(TPL_FILE, JSON.stringify([
    '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
    '衣物已完成清洗，金額 NT$ {amount}，可付款取件。',
    '衣物處理中，預付金額 NT$ {amount}',
    '訂金收訖 NT$ {amount}，感謝您的支持！'
  ], null, 2));
}
ensureDataFiles();

const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2));

/* ---------- LINE SDK ---------- */
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

/* ---------- LINE Pay 設定 & 函式 ---------- */
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

async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

    const body = {
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
    const signature = generateLinePaySignature(uri, body, nonce);

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
      logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
      return {
        success: true,
        paymentUrl: result.info.paymentUrl.web,
        orderId,
        transactionId: result.info.transactionId
      };
    } else {
      logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
      return { success: false, error: result.returnMessage };
    }
  } catch (error) {
    logger.logError('LINE Pay 付款請求錯誤', error);
    return { success: false, error: error.message };
  }
}

/* ---------- LINE 使用者入庫（方便顯示名） ---------- */
async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (error) {
    logger.logError('記錄用戶資料失敗', error, userId);
  }
}

/* ---------- Webhook ---------- */
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
        }
      } catch (err) {
        logger.logError('處理事件時出錯', err, event.source?.userId);
      }
    }
  } catch (err) {
    logger.logError('Webhook 全局錯誤', err);
  }
});

/* ---------- OAuth（保持你原有） ---------- */
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

app.get('/auth/status', (req, res) => {
  const isAuthorized = googleAuth.isAuthorized();
  res.json({ authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

/* ---------- 客戶清單（customerDB - 你原本就有） ---------- */
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
  if (!name) return res.status(400).json({ error: '請提供搜尋名稱' });
  const results = customerDB.searchCustomers(name);
  res.json({ total: results.length, users: results });
});

/* ---------- 客戶編號（永久化到 /data/customerMeta.json） ---------- */
app.get('/api/customer-meta', (_req, res) => {
  try { res.json({ success: true, ...readJSON(META_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/customer-meta/save', async (req, res) => {
  try {
    const { number, name, userId } = req.body || {};
    if (!name || !userId) return res.json({ success:false, error:'缺少 name 或 userId' });
    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId };
    writeJSON(META_FILE, meta);
    res.json({ success:true, number:no, data:meta.map[no] });
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

/* ---------- 模板（永久化 /data/messageTemplates.json） ---------- */
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
    arr[idx] = content || arr[idx]; writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(idx >= 0 && idx < arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(idx,1); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates: arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ---------- 付款頁 & 跳轉（綠界） ---------- */
app.get('/payment', (req, res) => {
  res.sendFile('payment.html', { root: './public' });
});

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

app.get('/payment/success', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款完成</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}h1{color:#fff;font-size:32px}p{font-size:18px}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 付款已完成</h1><p>感謝您的支付,我們會盡快處理您的訂單</p><p>您可以關閉此頁面了</p></div></body></html>');
});
app.get('/payment/linepay/cancel', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>付款取消</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款已取消</h1><p>您已取消此次付款</p><p>如需協助請聯繫客服</p></div></body></html>');
});

/* ---------- 持久 LINE Pay 入口（不會過期，但若超 7 天則拒絕） ---------- */
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 訂單不存在</h1><p>找不到此訂單</p></div></body></html>');
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天</p></div></body></html>');
  }
  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>✅ 訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ' + orderId + '</p></div></body></html>');
  }
  try {
    // 每次開啟重新向 LINE Pay 申請 20 分鐘 session
    logger.logToFile(`🔄 重新生成 LINE Pay 連結: ${orderId}`);
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
      res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head><body><div class="container"><h1>💳 前往 LINE Pay 付款</h1><div class="info"><p><strong>訂單編號:</strong> ' + orderId + '</p><p><strong>金額:</strong> NT$ ' + order.amount.toLocaleString() + '</p><p><strong>剩餘有效時間:</strong> ' + remainingHours + ' 小時</p></div><p>⏰ 付款連結 20 分鐘內有效</p><p>超時請回到原連結再次開啟即可</p><a href="' + linePayResult.paymentUrl + '" class="btn">立即前往 LINE Pay 付款</a></div><script>setTimeout(function(){window.location.href="' + linePayResult.paymentUrl + '"},1200)</script></body></html>');
    } else {
      res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>❌ 付款連結生成失敗</h1><p>' + linePayResult.error + '</p></body></html>');
    }
  } catch (error) {
    logger.logError('重新生成 LINE Pay 連結失敗', error);
    res.status(500).send('系統錯誤');
  }
});

/* ---------- LINE Pay 付款確認 ---------- */
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);
  if (order && orderManager.isExpired(orderId)) {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天</p></div></body></html>');
  }
  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount), currency: 'TWD' };
    const signature = generateLinePaySignature(uri, body, nonce);

    const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature
      },
      body: JSON.stringify(body)
    });
    const result = await response.json();

    if (result.returnCode === '0000') {
      if (order) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');

      logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);
      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, { type: 'text',
          text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名:${decodeURIComponent(userName)}\n付款金額:NT$ ${parseInt(amount).toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${orderId}\n交易編號:${transactionId}\n\n狀態:✅ 付款成功` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type: 'text',
          text: `✅ LINE Pay 付款成功\n\n感謝 ${decodeURIComponent(userName)} 的支付\n金額:NT$ ${parseInt(amount).toLocaleString()}\n訂單編號:${orderId}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙` });
      }
      res.redirect('/payment/success');
    } else {
      logger.logToFile(`❌ LINE Pay 付款確認失敗: ${result.returnCode} - ${result.returnMessage}`);
      res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款失敗</title></head><body><h1>❌ 付款失敗</h1><p>' + result.returnMessage + '</p><p>請聯繫客服處理</p></body></html>');
    }
  } catch (error) {
    logger.logError('LINE Pay 確認付款失敗', error);
    res.status(500).send('付款處理失敗');
  }
});

/* ---------- 綠界回調 ---------- */
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

app.post('/payment/ecpay/callback', async (req, res) => {
  try {
    logger.logToFile(`收到綠界回調: ${JSON.stringify(req.body)}`);
    const { MerchantTradeNo, RtnCode, RtnMsg, TradeAmt, PaymentDate, PaymentType, CustomField1: userId, CustomField2: userName } = req.body;

    if (RtnCode === '1') {
      const amount = parseInt(TradeAmt);
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');

      logger.logToFile(`✅ 綠界付款成功,已標記 ${updated} 筆訂單為已付款`);
      const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, { type: 'text',
          text: `🎉 收到綠界付款通知\n\n客戶姓名: ${userName}\n付款金額: NT$ ${amount.toLocaleString()}\n付款方式: ${getPaymentTypeName(PaymentType)}\n付款時間: ${PaymentDate}\n綠界訂單: ${MerchantTradeNo}\n\n狀態: ✅ 付款成功` });
      }
      if (userId && userId !== 'undefined') {
        await client.pushMessage(userId, { type: 'text',
          text: `✅ 付款成功\n\n感謝 ${userName} 的支付\n金額: NT$ ${amount.toLocaleString()}\n綠界訂單: ${MerchantTradeNo}\n\n我們會盡快處理您的訂單\n感謝您的支持 💙` });
      }
      logger.logToFile(`✅ 綠界付款成功: ${userName} - ${TradeAmt}元 - 訂單: ${MerchantTradeNo}`);
    } else {
      logger.logToFile(`❌ 綠界付款異常: ${RtnMsg}`);
    }
    res.send('1|OK');
  } catch (err) {
    logger.logError('處理綠界回調失敗', err);
    res.send('0|ERROR');
  }
});

/* ---------- 發送付款（Flex Message 中文按鈕） ---------- */
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);

  if (!userId || !userName || !amount) {
    logger.logToFile(`❌ 參數驗證失敗`);
    return res.status(400).json({ success:false, error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }

  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success:false, error: '金額必須是正整數' });
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

      // 短網址化（失敗就用原始）
      try {
        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
        const short = await response.text();
        if (short && short.startsWith('http')) ecpayLink = short;
      } catch {}
    }

    // LINE Pay
    if (type === 'linepay' || type === 'both') {
      const linePayResult = await createLinePayPayment(userId, userName, numAmount);
      if (linePayResult.success) {
        linePayOrderId = linePayResult.orderId;
        orderManager.createOrder(linePayResult.orderId, { userId, userName, amount: numAmount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);

        // 持久入口（不會過期；每次點開再換 20 分鐘）
        const persistentUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app'}/payment/linepay/pay/${linePayResult.orderId}`;
        linepayLink = persistentUrl;
        try {
          const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
          const short = await response.text();
          if (short && short.startsWith('http')) linepayLink = short;
        } catch {}
      } else {
        logger.logToFile(`❌ LINE Pay 付款請求失敗`);
      }
    }

    // ---- 以 Flex Message 送中文按鈕 ----
    const finalMsg = (customMessage || '').trim();
    const flex = {
      type: 'flex',
      altText: `付款連結 - ${userName} NT$ ${numAmount.toLocaleString()}`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'text', text: '付款連結', weight: 'bold', size: 'lg' },
            { type: 'text', text: `客戶：${userName}`, size: 'sm', color: '#888888' },
            { type: 'text', text: `金額：NT$ ${numAmount.toLocaleString()}`, size: 'sm', color: '#888888' },
            ...(finalMsg ? [{ type:'text', text: finalMsg, wrap:true, size:'sm' }] : []),
            { type: 'separator', margin: 'md' },
            ...( (type==='ecpay'||type==='both') && ecpayLink ? [{
              type:'button', style:'primary', color:'#2563eb',
              action:{ type:'uri', label:'綠界信用卡', uri: ecpayLink }
            }] : []),
            ...( (type==='linepay'||type==='both') && linepayLink ? [{
              type:'button', style:'primary', color:'#16a34a',
              action:{ type:'uri', label:'LINE Pay', uri: linepayLink }
            }] : []),
            { type:'text', text:'✅ 付款後系統會自動通知我們', size:'xs', color:'#6b7280' }
          ]
        }
      }
    };
    await client.pushMessage(userId, flex);

    logger.logToFile(`✅ 已發送付款連結: ${userName} - ${numAmount}元 (${type})`);
    res.json({
      success: true,
      message: '付款連結已發送',
      data: {
        userId, userName, amount: numAmount, paymentType: type,
        ecpayLink: ecpayLink || null, linepayLink: linepayLink || null,
        ecpayOrderId: ecpayOrderId || null, linePayOrderId: linePayOrderId || null,
        customMessage: finalMsg
      }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ success:false, error: '發送失敗', details: err.message });
  }
});

/* ---------- 訂單 API（保持原有功能） ---------- */
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  const orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const mapped = orders.map(o => ({
    ...o,
    isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  res.json({ success: true, total: mapped.length, orders: mapped, statistics: orderManager.getStatistics() });
});

app.get('/api/order/:orderId', (req, res) => {
  const o = orderManager.getOrder(req.params.orderId);
  if (!o) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({ success:true, order: {
    ...o, isExpired: orderManager.isExpired(o.orderId),
    remainingTime: Math.max(0, o.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now()) / (1000 * 60 * 60))
  }});
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  try {
    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';
    const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);

    let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayLink = t2;
    } catch {}

    if (linePayResult.success) {
      orderManager.updatePaymentInfo(orderId, linePayResult.transactionId, linePayResult.paymentUrl);
      const persistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;
      let linepayShort = persistentUrl;
      try {
        const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
        const t1 = await r1.text();
        if (t1 && t1.startsWith('http')) linepayShort = t1;
      } catch {}

      await client.pushMessage(order.userId, {
        type: 'text',
        text:
          `🔄 付款連結已重新生成\n\n` +
          `訂單編號: ${orderId}\n` +
          `客戶姓名: ${order.userName}\n` +
          `金額: NT$ ${order.amount.toLocaleString()}\n\n` +
          `— 請選擇付款方式 —\n` +
          `【信用卡／綠界】\n${ecpayLink}\n\n` +
          `【LINE Pay】\n${linepayShort}\n\n` +
          `備註：LINE Pay 每次開啟 20 分鐘有效；過時請回同一連結再次開啟。`
      });

      orderManager.markReminderSent(orderId);
      logger.logToFile(`✅ 單筆續約重發（綠界+LINE Pay）：${orderId}`);
      return res.json({ success:true, message:'訂單已續約並重新發送付款連結（含綠界 + LINE Pay）', order,
        links:{ ecpay: ecpayLink, linepay: linepayShort } });
    } else {
      return res.status(500).json({ success:false, error:'重新生成 LINE Pay 連結失敗' });
    }
  } catch (error) {
    logger.logError('續約訂單失敗', error);
    return res.status(500).json({ success:false, error: error.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (ok) res.json({ success:true, message:'訂單已刪除' });
  else res.status(404).json({ success:false, error:'找不到此訂單' });
});

app.post('/api/orders/send-reminders', async (req, res) => {
  const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
  if (ordersNeedingReminder.length === 0) {
    return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });
  }
  let sent = 0;
  const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

  for (const order of ordersNeedingReminder) {
    try {
      const linePayResult = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (linePayResult.success) {
        orderManager.createOrder(linePayResult.orderId, { userId: order.userId, userName: order.userName, amount: order.amount });
        orderManager.updatePaymentInfo(linePayResult.orderId, linePayResult.transactionId, linePayResult.paymentUrl);
        orderManager.deleteOrder(order.orderId);

        const persistentUrl = `${baseURL}/payment/linepay/pay/${linePayResult.orderId}`;
        let linepayShort = persistentUrl;
        try {
          const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistentUrl)}`);
          const result = await response.text();
          if (result && result.startsWith('http')) linepayShort = result;
        } catch {}

        let ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
        try {
          const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayLink)}`);
          const t2 = await r2.text();
          if (t2 && t2.startsWith('http')) ecpayLink = t2;
        } catch {}

        await client.pushMessage(order.userId, {
          type: 'text',
          text:
            `😊 付款提醒\n\n` +
            `親愛的 ${order.userName} 您好，您於本次洗衣服務仍待付款\n` +
            `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
            `【信用卡／綠界】\n${ecpayLink}\n\n` +
            `【LINE Pay】\n${linepayShort}\n\n` +
            `備註：LINE Pay 每次開啟 20 分鐘有效；過時請回同一連結再次開啟。`
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
  res.json({ success:true, message:`已發送 ${sent} 筆付款提醒`, sent });
});

app.get('/api/orders/statistics', (_req, res) => {
  res.json({ success:true, statistics: orderManager.getStatistics() });
});

app.post('/api/orders/clean-expired', (_req, res) => {
  const cleaned = orderManager.cleanExpiredOrders();
  res.json({ success:true, message:`已清理 ${cleaned} 筆過期訂單`, cleaned });
});

/* ---------- 其他小工具 & 測試 ---------- */
app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, error:'沒有收到圖片' });
    const type = req.body.type || 'before';
    const { customerLogService } = require('./services/multiSheets');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const typeLabel = type === 'after' ? '洗後' : '洗前';
    const filename = `${typeLabel}_test_${timestamp}.jpg`;
    const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
    if (result.success) {
      logger.logToFile(`✅ ${typeLabel}測試上傳成功: ${filename}`);
      res.json({ success:true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    } else res.status(500).json({ success:false, error: result.error });
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    res.status(500).json({ success:false, error: error.message });
  }
});

/* ---------- 啟動 & Scheduler（兩天未付 → 白天提醒） ---------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`伺服器正在運行, 端口: ${PORT}`);
  logger.logToFile(`伺服器正在運行, 端口: ${PORT}`);
  try {
    await customerDB.loadAllCustomers();
    console.log('✅ 客戶資料載入完成');
  } catch (error) {
    console.error('❌ 客戶資料載入失敗:', error.message);
  }

  // 每天例行清過期
  setInterval(() => orderManager.cleanExpiredOrders(), 24 * 60 * 60 * 1000);
});

/** 
 * 每天 10:30 與 18:30（台北時間）觸發「兩天未付」提醒。
 * 你的 /api/orders/send-reminders 內部會自動：
 *  - 為未付訂單產生新連結（綠界 + LINE Pay）
 *  - 任一通道付款成功 → 不再提醒
 */
cron.schedule('30 10,18 * * *', async () => {
  try {
    const res = await fetch(`${process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app'}/api/orders/send-reminders`, { method:'POST' });
    const d = await res.json().catch(()=>({success:false}));
    logger.logToFile(`⏰ Scheduler 觸發提醒：${JSON.stringify(d)}`);
  } catch (e) {
    logger.logError('Scheduler 觸發提醒失敗', e);
  }
}, { timezone: 'Asia/Taipei' });