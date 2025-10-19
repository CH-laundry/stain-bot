// index.js －－ 完整版
// ----------------------------------------------------
// 必備套件
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
require('dotenv').config();

// 服務 & SDK
const { Client } = require('@line/bot-sdk');

// 你的服務（沿用原有檔案，如無可先建立空殼再逐步完善）
const orderManager = require('./services/orderManager'); // 你前面貼的版本可直接用
const customerDB   = require('./services/customerDatabase'); // 若暫時沒有，也不影響本檔執行
const logger       = require('./services/logger'); // 若沒有可改成 console.log

// 如果沒有 logger 檔，避免整個爆掉（簡單代管）
if (!logger || !logger.logToFile) {
  console.warn('⚠️ services/logger 未找到，改用 console 代打');
  global.logger = {
    logToFile: (...a) => console.log('[LOG]', ...a),
    logError : (...a) => console.error('[ERR]', ...a),
    getLogFilePath: () => path.join(__dirname, 'logs.txt')
  };
}

// ----------------------------------------------------
// 常數與檔案
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態檔（前端 UI）
app.use(express.static(path.join(__dirname, 'public')));

// DATA 檔
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');     // {nextNo, map:{[no]:{name,userId}}}
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json'); // string[]
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
if (!fs.existsSync(TPL_FILE))  fs.writeFileSync(TPL_FILE, JSON.stringify([
  '您好，金額 NT$ {amount}，請儘速付款，謝謝！',
  '本次已完成清洗，費用 NT$ {amount}，可來店取件喔！',
  '訂金已收 NT$ {amount}，感謝支持！'
], null, 2));

const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2));

// ----------------------------------------------------
// LINE BOT
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ----------------------------------------------------
// LINE Pay（必要環境）
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: (process.env.LINE_PAY_ENV === 'sandbox')
    ? 'https://sandbox-api-pay.line.me'
    : 'https://api-pay.line.me'
};

function lpSign(uri, body, nonce) {
  const msg = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
    .update(msg).digest('base64');
}

// 產生 LINE Pay「正式 20 分鐘票券」
async function createLinePayOnce(orderId, userId, userName, amount) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const reqBody = {
    amount, currency:'TWD', orderId,
    packages: [{ id: orderId, amount, name: 'C.H精緻洗衣', products:[{ name:'洗衣服務', quantity:1, price:amount }] }],
    redirectUrls: {
      confirmUrl: `${baseURL()}/payment/linepay/confirm?orderId=${orderId}&userId=${encodeURIComponent(userId)}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
      cancelUrl : `${baseURL()}/payment/linepay/cancel`
    }
  };
  const uri = '/v3/payments/request';
  const sig = lpSign(uri, reqBody, nonce);
  const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
      'X-LINE-Authorization-Nonce': nonce,
      'X-LINE-Authorization': sig
    },
    body: JSON.stringify(reqBody)
  });
  const j = await r.json();
  if (j.returnCode === '0000') {
    return { success:true, transactionId:j.info.transactionId, paymentUrl:j.info.paymentUrl.web };
  }
  return { success:false, error:j.returnMessage || 'LINE Pay 建立票券失敗' };
}

// 你的綠界前置（保留原本 openai/services 產生器）
// 這裡提供「最小可運作」假連結（若已有 createECPayPaymentLink 就使用它）
let createECPayPaymentLink = (userId, userName, amount) => {
  const payload = Buffer.from(JSON.stringify({
    MerchantTradeNo:`EC${Date.now()}`,
    TradeDesc:'C.H精緻洗衣',
    TotalAmount: amount,
    ItemName:'洗衣服務',
    ReturnURL: `${baseURL()}/payment/ecpay/callback`,
    CustomField1: userId,
    CustomField2: userName
  })).toString('base64');
  return `${baseURL()}/payment/redirect?data=${encodeURIComponent(payload)}`;
};
try {
  // 若你已有真正產生器，會覆蓋上面假函式
  ({ createECPayPaymentLink } = require('./services/openai'));
} catch { /* 忽略，使用上面的簡化版 */ }

// ----------------------------------------------------
// 工具
const baseURL = () => process.env.RAILWAY_PUBLIC_DOMAIN || `https://stain-bot-production-2593.up.railway.app`;
async function tiny(url) {
  try {
    const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    const t = await r.text();
    return (t && t.startsWith('http')) ? t : url;
  } catch { return url; }
}

// ----------------------------------------------------
// 客戶編號 / 訊息模板 API（前端 /api/... 統一路徑）
app.get('/api/customer-meta', (_req, res) => {
  try { const meta = readJSON(META_FILE); res.json({ success:true, ...meta }); }
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

app.get('/api/templates', (_req, res) => {
  try { res.json({ success:true, templates: readJSON(TPL_FILE) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.json({ success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates:arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/templates/:idx', (req, res) => {
  try {
    const i = parseInt(req.params.idx, 10);
    const { content } = req.body || {};
    const arr = readJSON(TPL_FILE);
    if (!(i>=0 && i<arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr[i] = content || arr[i]; writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates:arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/templates/:idx', (req, res) => {
  try {
    const i = parseInt(req.params.idx, 10);
    const arr = readJSON(TPL_FILE);
    if (!(i>=0 && i<arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(i,1); writeJSON(TPL_FILE, arr);
    res.json({ success:true, templates:arr });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// 方便前端的 /api/users（若沒有 customerDB，就回傳 customerMeta 裡的）
app.get('/api/users', (_req, res) => {
  try {
    let users = [];
    try { users = customerDB.getAllCustomers(); } catch {}
    if (!users || users.length===0) {
      const meta = readJSON(META_FILE).map || {};
      users = Object.entries(meta).map(([no, c]) => ({ number:no, name:c.name, userId:c.userId }));
    }
    res.json({ success:true, total: users.length, users });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// ----------------------------------------------------
// 訂單 API（含永久入口、兩天提醒、任一管道付款皆成交）
app.get('/api/orders', (_req, res) => {
  const orders = orderManager.getAllOrders()
    .map(o => ({ ...o, isExpired: orderManager.isExpired(o.orderId),
      remainingTime: Math.max(0, o.expiryTime - Date.now()),
      remainingHours: Math.floor(Math.max(0, o.expiryTime - Date.now())/3600000)
    }));
  res.json({ success:true, total: orders.length, orders, statistics: orderManager.getStatistics() });
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  // 永久入口本身不換；只是再推一次兩條連結
  const lpLinkPermanent = `${baseURL()}/payment/linepay/pay/${orderId}`;
  let lpShort = await tiny(lpLinkPermanent);
  let ecLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
  ecLink = await tiny(ecLink);

  // 推給客人（中文標籤）
  await client.pushMessage(order.userId, {
    type:'text',
    text:
`🔄 付款連結已重新生成

金額：NT$ ${order.amount.toLocaleString()}

綠界信用卡：
${ecLink}

LINE Pay：
${lpShort}

✅ 任一完成即視為已付款`
  });

  orderManager.markReminderSent(orderId);

  res.json({ success:true, message:'已續期並重新發送連結', links:{ ecpay: ecLink, linepay: lpShort }, order });
});

// 兩天自動提醒（也會在啟動時安排 setInterval）
async function remindDueOrders() {
  const list = orderManager.getOrdersNeedingReminder();
  for (const order of list) {
    const lpPermanent = `${baseURL()}/payment/linepay/pay/${order.orderId}`;
    let lpShort = await tiny(lpPermanent);
    let ec = createECPayPaymentLink(order.userId, order.userName, order.amount);
    ec = await tiny(ec);
    await client.pushMessage(order.userId, {
      type:'text',
      text:
`⏰ 付款提醒

金額：NT$ ${order.amount.toLocaleString()}

綠界信用卡：
${ec}

LINE Pay：
${lpShort}

✅ 任一完成即視為已付款`
    });
    orderManager.markReminderSent(order.orderId);
  }
  return list.length;
}

app.post('/api/orders/send-reminders', async (_req, res) => {
  const sent = await remindDueOrders();
  res.json({ success:true, message:`已發送 ${sent} 筆付款提醒`, sent });
});

// ----------------------------------------------------
// 發送付款（提供 /api/send-payment，前端統一叫這個）
app.post('/api/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentType, customMessage } = req.body || {};
    if (!userId || !userName || !amount) return res.status(400).json({ success:false, error:'缺少必要參數' });
    const amt = parseInt(amount, 10); if (isNaN(amt) || amt<=0) return res.status(400).json({ success:false, error:'金額需為正整數' });
    const type = paymentType || 'both';

    // 建立一筆主訂單（用 LINE Pay 的 orderId，當永久入口識別；若只發綠界也會建 EC 專用單）
    const orderId = `LP${Date.now()}${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    orderManager.createOrder(orderId, { userId, userName, amount: amt });

    // 永久入口（永不失效）
    const lpPermanent = `${baseURL()}/payment/linepay/pay/${orderId}`;
    let lpShort = await tiny(lpPermanent);

    // 綠界網址（可長存）
    let ec = createECPayPaymentLink(userId, userName, amt);
    ec = await tiny(ec);

    // 組訊息（中文標籤，不顯示固定入口字樣）
    let text='';
    if (type === 'ecpay') {
      text =
`${customMessage ? customMessage+'\n\n' : ''}綠界信用卡：
${ec}

✅ 付款後系統會自動通知我們`;
    } else if (type === 'linepay') {
      text =
`${customMessage ? customMessage+'\n\n' : ''}LINE Pay：
${lpShort}

✅ 付款後系統會自動通知我們`;
    } else {
      text =
`${customMessage ? customMessage+'\n\n' : ''}金額：NT$ ${amt.toLocaleString()}

綠界信用卡：
${ec}

LINE Pay：
${lpShort}

✅ 任一完成即視為已付款`;
    }

    await client.pushMessage(userId, { type:'text', text });

    return res.json({
      success:true,
      message:'付款連結已發送',
      data: { orderId, userId, userName, amount: amt, links:{ ecpay: ec, linepay: lpShort }, paymentType:type }
    });
  } catch (e) {
    logger.logError('發送付款失敗', e);
    res.status(500).json({ success:false, error:e.message || '發送失敗' });
  }
});

// 兼容舊路徑（若前端還打 /send-payment 也OK）
app.post('/send-payment', (req, res) => app._router.handle(req, res, () => {}, 'post', '/api/send-payment'));

// ----------------------------------------------------
// 永久入口：客人每次點都「即時生成 20 分鐘票券」再導過去
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('<h3>❌ 訂單不存在</h3>');
  if (order.status === 'paid') return res.send('<h3>✅ 訂單已付款</h3>');

  // 重新生成一次正式票券
  const r = await createLinePayOnce(orderId, order.userId, order.userName, order.amount);
  if (!r.success) return res.status(500).send(`<h3>❌ 生成付款頁失敗</h3><p>${r.error}</p>`);
  orderManager.updatePaymentInfo(orderId, r.transactionId, r.paymentUrl);

  // 自動導向官方頁
  res.send(`<!doctype html><meta charset="utf-8"><title>前往付款</title>
<script>location.href=${JSON.stringify(r.paymentUrl)};</script>
<p>即將前往 LINE Pay 付款頁…</p>`);
});

// LINE Pay 確認（成功後：把所有 pending 訂單改 paid，停止提醒）
app.get('/payment/linepay/confirm', async (req, res) => {
  try {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount,10), currency:'TWD' };
    const sig = lpSign(uri, body, nonce);
    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': sig
      },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.returnCode !== '0000') return res.status(400).send(`<h3>❌ 付款確認失敗</h3><p>${j.returnMessage}</p>`);

    // 任一管道完成即成交：把該 userId 的 pending 單全標 paid
    const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
    logger.logToFile(`✅ LINE Pay 付款成功，已標記 ${updated} 筆為已付款`);

    // 提醒店家
    if (process.env.ADMIN_USER_ID) {
      await client.pushMessage(process.env.ADMIN_USER_ID, {
        type:'text',
        text:`🎉 收到 LINE Pay 付款\n客戶：${decodeURIComponent(userName)}\n金額：NT$ ${parseInt(amount,10).toLocaleString()}\n訂單：${orderId}\n交易：${transactionId}`
      });
    }
    // 回覆客人
    if (userId && userId !== 'undefined') {
      await client.pushMessage(userId, { type:'text', text:`✅ 付款成功，感謝 ${decodeURIComponent(userName)}！` });
    }

    res.send('<h3>✅ 付款成功</h3>');
  } catch (e) {
    logger.logError('LINE Pay 確認錯誤', e);
    res.status(500).send('付款處理失敗');
  }
});

// 綠界 redirect（長期有效）
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  const form = Buffer.from(
    `<form id=f action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method=post>${
      Object.entries(JSON.parse(Buffer.from(decodeURIComponent(data),'base64').toString()))
      .map(([k,v])=>`<input type="hidden" name="${k}" value="${String(v).replace(/"/g,'&quot;')}">`).join('')
    }</form><script>f.submit()</script>`
  ).toString('utf8');
  res.send(`<!doctype html><meta charset="utf-8"><title>跳轉綠界</title>${form}`);
});

// 綠界 callback（任一管道完成即成交）
app.post('/payment/ecpay/callback', express.urlencoded({extended:true}), async (req, res) => {
  try {
    const { RtnCode, TradeAmt, CustomField1: userId, CustomField2: userName, MerchantTradeNo } = req.body || {};
    if (String(RtnCode) === '1') {
      const amount = parseInt(TradeAmt, 10) || 0;
      const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', '綠界支付');
      logger.logToFile(`✅ 綠界付款成功，已標記 ${updated} 筆為已付款`);
      if (process.env.ADMIN_USER_ID) {
        await client.pushMessage(process.env.ADMIN_USER_ID, {
          type:'text',
          text:`🎉 收到綠界付款\n客戶：${userName}\n金額：NT$ ${amount.toLocaleString()}\n綠界訂單：${MerchantTradeNo}`
        });
      }
      if (userId) await client.pushMessage(userId, { type:'text', text:`✅ 付款成功，感謝 ${userName}！` });
    }
    res.send('1|OK');
  } catch (e) {
    logger.logError('綠界回調失敗', e);
    res.send('0|ERROR');
  }
});

// ----------------------------------------------------
// 前端首頁
app.get('/payment', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

// ----------------------------------------------------
// 啟動 & 排程（每 6 小時檢查需提醒的訂單）
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  try { await customerDB.loadAllCustomers?.(); } catch {}
  setInterval(() => { orderManager.cleanExpiredOrders(); }, 24*60*60*1000);
  setInterval(remindDueOrders, 6*60*60*1000);
});