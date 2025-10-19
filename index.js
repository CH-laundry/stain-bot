// ===== 基礎載入 =====
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
const messageHandler = require('./services/message');
const googleAuth = require('./services/googleAuth');
const orderManager = require('./services/orderManager');
const customerDB = require('./services/customerDatabase');

// 你原本的綠界產連結函式
const { createECPayPaymentLink } = require('./services/openai');

// ===== App 設定 =====
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const PUBLIC_BASE = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-0fac.up.railway.app';

// ===== LINE SDK =====
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ===== Google 私鑰（若有）=====
if (process.env.GOOGLE_PRIVATE_KEY) {
  try {
    fs.writeFileSync('./sheet.json', process.env.GOOGLE_PRIVATE_KEY);
    console.log('sheet.json 初始化完成');
  } catch (e) {
    console.log('sheet.json 初始化失敗：', e.message);
  }
}

// ===== 檔案型資料：客戶編號 / 模板 =====
const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'customerMeta.json');
const TPL_FILE  = path.join(DATA_DIR, 'messageTemplates.json');
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ nextNo: 1, map: {} }, null, 2));
  if (!fs.existsSync(TPL_FILE))  fs.writeFileSync(TPL_FILE, JSON.stringify([
    '您好,已收回衣物,金額 NT$ {amount},請儘速付款,謝謝!',
    '您的衣物已清洗完成,金額 NT$ {amount},可付款取件',
    '衣物處理中,預付金額 NT$ {amount}',
    '訂金收訖 NT$ {amount},感謝您的支持!'
  ], null, 2));
}
ensureDataFiles();
const readJSON  = fp => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, obj) => fs.writeFileSync(fp, JSON.stringify(obj, null, 2));

// ===== LINE Pay =====
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox' ? 'https://sandbox-api-pay.line.me' : 'https://api-pay.line.me'
};
const signLinePay = (uri, body, nonce) =>
  crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
        .update(LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce)
        .digest('base64');

async function createLinePayPayment(userId, userName, amount){
  try{
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2,5).toUpperCase()}`;
    const nonce   = crypto.randomBytes(16).toString('base64');
    const body = {
      amount, currency:'TWD', orderId,
      packages:[{ id:orderId, amount, name:'C.H精緻洗衣服務', products:[{ name:'洗衣服務費用', quantity:1, price:amount }] }],
      redirectUrls:{
        confirmUrl: `${PUBLIC_BASE}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
        cancelUrl:  `${PUBLIC_BASE}/payment/linepay/cancel`
      }
    };
    const uri = '/v3/payments/request';
    const res = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signLinePay(uri, body, nonce)
      },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (j.returnCode === '0000'){
      logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
      return { success:true, paymentUrl:j.info.paymentUrl.web, orderId, transactionId:j.info.transactionId };
    }
    logger.logToFile(`❌ LINE Pay 付款請求失敗: ${j.returnCode} - ${j.returnMessage}`);
    return { success:false, error:j.returnMessage };
  }catch(e){
    logger.logError('LINE Pay 付款請求錯誤', e);
    return { success:false, error:e.message };
  }
}

// ===== Flex 訊息（兩個按鈕）=====
function buildPaymentFlex({ userName, amount, ecpayUrl, linepayUrl, title='付款連結' }){
  return {
    type: 'flex',
    altText: `付款連結｜${userName} NT$ ${amount.toLocaleString()}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'C.H 精緻洗衣', weight: 'bold', size: 'md', color: '#667eea' },
          { type: 'text', text: title, weight: 'bold', size: 'lg', margin: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'vertical', margin: 'md', contents: [
              { type:'text', text:`客戶：${userName}`, size:'sm', color:'#666666' },
              { type:'text', text:`金額：NT$ ${amount.toLocaleString()}`, size:'sm', color:'#666666', margin:'sm' }
          ]}
        ]
      },
      footer: {
        type:'box', layout:'vertical', spacing:'sm', contents: [
          { type:'button', style:'primary', action:{ type:'uri', label:'綠界信用卡', uri: ecpayUrl } },
          { type:'button', style:'secondary', action:{ type:'uri', label:'LINE Pay', uri: linepayUrl } }
        ]
      }
    }
  };
}

// ===== Webhook（保留）=====
async function saveUserProfile(userId){
  try{ const profile = await client.getProfile(userId); await customerDB.saveCustomer(userId, profile.displayName); }
  catch(e){ logger.logError('記錄用戶資料失敗', e, userId); }
}
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  try{
    const events = req.body.events || [];
    for (const event of events){
      try{
        if (event.type !== 'message' || !event.source.userId) continue;
        const userId = event.source.userId;
        await saveUserProfile(userId);
        if (event.message.type === 'text'){
          const text = (event.message.text||'').trim();
          logger.logUserMessage(userId, text);
          await messageHandler.handleTextMessage(userId, text, text);
        }else if (event.message.type === 'image'){
          logger.logUserMessage(userId, '上傳了一張圖片');
          await messageHandler.handleImageMessage(userId, event.message.id);
        }
      }catch(e){ logger.logError('處理事件時出錯', e, event.source?.userId); }
    }
  }catch(e){ logger.logError('全局錯誤', e); }
});

// ===== OAuth / 測試頁（保留）=====
app.get('/auth', (req, res) => {
  try { res.redirect(googleAuth.getAuthUrl()); }
  catch (e) { logger.logError('生成授權 URL 失敗', e); res.status(500).send('授權失敗: ' + e.message); }
});
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query; if (!code) return res.status(400).send('缺少授權碼');
  try { await googleAuth.getTokenFromCode(code); logger.logToFile('✅ Google OAuth 授權成功');
    res.send('<!doctype html><meta charset="utf-8"><title>授權成功</title>已授權，關閉此視窗即可');
  } catch(e){ logger.logError('處理授權碼失敗', e); res.status(500).send('授權失敗: ' + e.message); }
});

// ===== 綠界跳轉（保留）=====
app.get('/payment/redirect', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send('缺少付款資料');
  try{
    const d = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    const inputs = Object.keys(d).map(k=>`<input type="hidden" name="${k}" value="${d[k]}">`).join('');
    res.send(`<!doctype html><meta charset="utf-8"><title>跳轉到綠界付款</title>
      <h3>正在跳轉到付款頁面...</h3>
      <form id="f" action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5" method="post">${inputs}
      <button type="submit">前往付款</button></form>
      <script>setTimeout(()=>document.getElementById('f').submit(),400)</script>`);
  }catch(e){ logger.logError('付款跳轉失敗', e); res.status(500).send('付款連結錯誤'); }
});
app.get('/payment/success', (_req, res)=> res.send('<!doctype html><meta charset="utf-8"><h1>✅ 付款已完成</h1>'));
app.get('/payment/linepay/cancel', (_req, res)=> res.send('<!doctype html><meta charset="utf-8"><h1>❌ 付款已取消</h1>'));

// ===== 不會失效的「固定入口」：LINE Pay =====
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  let order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');

  if (orderManager.isExpired(orderId)) { order = orderManager.renewOrder(orderId); logger.logToFile(`🔄 LINE Pay 過期自動續期: ${orderId}`); }
  if (order.status === 'paid') return res.send('<!doctype html><meta charset="utf-8"><h3>✅ 訂單已付款</h3>');

  try{
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (!lp.success) throw new Error(lp.error||'LINE Pay 生成失敗');
    orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);
    res.redirect(lp.paymentUrl); // 直接帶去 LINE Pay 短期頁，但入口不會失效
  }catch(e){
    logger.logError('生成 LINE Pay 連結失敗', e);
    res.status(500).send('系統錯誤，請稍後再試');
  }
});

// ===== 不會失效的「固定入口」：綠界 =====
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  let order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('訂單不存在');

  if (orderManager.isExpired(orderId)) { order = orderManager.renewOrder(orderId); logger.logToFile(`🔄 綠界 過期自動續期: ${orderId}`); }
  if (order.status === 'paid') return res.send('<!doctype html><meta charset="utf-8"><h3>✅ 訂單已付款</h3>');

  try{
    const ecpayUrl = createECPayPaymentLink(order.userId, order.userName, order.amount);
    res.redirect(ecpayUrl); // 固定入口 → 轉去當次新產的綠界頁
  }catch(e){
    logger.logError('生成綠界連結失敗', e);
    res.status(500).send('系統錯誤，請稍後再試');
  }
});

// ===== LINE Pay 付款確認（保留）=====
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, userId, userName, amount } = req.query;
  const order = orderManager.getOrder(orderId);
  if (order && orderManager.isExpired(orderId)) return res.send('<!doctype html><meta charset="utf-8"><h3>⏰ 訂單已過期</h3>');

  try{
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: parseInt(amount), currency:'TWD' };
    const resLP = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signLinePay(uri, body, nonce)
      },
      body: JSON.stringify(body)
    });
    const j = await resLP.json();
    if (j.returnCode === '0000'){
      if (order) orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
      orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
      res.redirect('/payment/success');
    }else{
      res.send(`<meta charset="utf-8">付款失敗：${j.returnMessage||'未知錯誤'}`);
    }
  }catch(e){ logger.logError('LINE Pay 確認失敗', e); res.status(500).send('付款處理失敗'); }
});

// ===== 訂單 APIs（保留）=====
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  const list = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const mapped = list.map(o => ({ ...o, isExpired: orderManager.isExpired(o.orderId), remainingTime: Math.max(0, o.expiryTime-Date.now()), remainingHours: Math.floor(Math.max(0, o.expiryTime-Date.now())/(1000*60*60)) }));
  res.json({ success:true, total:mapped.length, orders:mapped, statistics: orderManager.getStatistics() });
});
app.get('/api/order/:orderId', (req, res) => {
  const order = orderManager.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({ success:true, order:{ ...order, isExpired: orderManager.isExpired(order.orderId), remainingTime: Math.max(0, order.expiryTime-Date.now()), remainingHours: Math.floor(Math.max(0, order.expiryTime-Date.now())/(1000*60*60)) } });
});

// ===== 續期 + 重新發送（Flex 訊息）=====
app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success:false, error:'找不到此訂單' });

  try{
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
    if (lp.success) orderManager.updatePaymentInfo(orderId, lp.transactionId, lp.paymentUrl);

    const ecpayUrl  = `${PUBLIC_BASE}/payment/ecpay/pay/${orderId}`;
    const linepayUrl= `${PUBLIC_BASE}/payment/linepay/pay/${orderId}`;

    const flex = buildPaymentFlex({ userName:order.userName, amount:order.amount, ecpayUrl, linepayUrl, title:'付款連結已重新生成' });
    await client.pushMessage(order.userId, flex);
    orderManager.markReminderSent(orderId);

    res.json({ success:true, message:'已續期並重新發送', links:{ ecpay:ecpayUrl, linepay:linepayUrl } });
  }catch(e){
    logger.logError('續約訂單失敗', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

// ===== 刪除 =====
app.delete('/api/order/:orderId', (req, res) => {
  const ok = orderManager.deleteOrder(req.params.orderId);
  if (!ok) return res.status(404).json({ success:false, error:'找不到此訂單' });
  res.json({ success:true, message:'訂單已刪除' });
});

// ===== 定時提醒（Flex 訊息）=====
app.post('/api/orders/send-reminders', async (req, res) => {
  const targets = orderManager.getOrdersNeedingReminder();
  if (targets.length === 0) return res.json({ success:true, message:'目前沒有需要提醒的訂單', sent:0 });

  let sent = 0;
  for (const order of targets){
    try{
      orderManager.renewOrder(order.orderId); // 過期續 7 天
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
      if (lp.success) orderManager.updatePaymentInfo(order.orderId, lp.transactionId, lp.paymentUrl);

      const ecpayUrl  = `${PUBLIC_BASE}/payment/ecpay/pay/${order.orderId}`;
      const linepayUrl= `${PUBLIC_BASE}/payment/linepay/pay/${order.orderId}`;
      const flex = buildPaymentFlex({ userName:order.userName, amount:order.amount, ecpayUrl, linepayUrl, title:'付款提醒' });
      await client.pushMessage(order.userId, flex);

      orderManager.markReminderSent(order.orderId);
      sent++;
    }catch(e){ logger.logError(`發送提醒失敗: ${order.orderId}`, e); }
  }
  res.json({ success:true, message:`已發送 ${sent} 筆付款提醒`, sent });
});

// ===== 前端頁 =====
app.get('/payment', (req, res) => { res.sendFile('payment.html', { root:'./public' }); });

// ===== 客戶 / 模板同步 APIs（保留）=====
app.get('/api/users', (_req, res) => res.json({ total: customerDB.getAllCustomers().length, users: customerDB.getAllCustomers() }));
app.get('/api/user/:userId', (req, res) => { const u = customerDB.getCustomer(req.params.userId); return u ? res.json(u) : res.status(404).json({ error:'找不到此用戶' }); });
app.put('/api/user/:userId/name', express.json(), async (req, res) => {
  const { userId } = req.params, { displayName } = req.body;
  if (!displayName || !displayName.trim()) return res.status(400).json({ error:'名稱不能為空' });
  try { const u = await customerDB.updateCustomerName(userId, displayName.trim()); res.json({ success:true, message:'名稱已更新', user:u }); }
  catch(e){ res.status(500).json({ error:e.message }); }
});
app.get('/api/search/user', (req, res) => {
  const { name } = req.query; if (!name) return res.status(400).json({ error:'請提供搜尋名稱' });
  const results = customerDB.searchCustomers(name); res.json({ total:results.length, users:results });
});

// 客戶編號
app.get('/api/customer-meta', (_req,res)=>{ try{ res.json({ success:true, ...readJSON(META_FILE) }); }catch(e){ res.status(500).json({ success:false, error:e.message }); }});
app.post('/api/customer-meta/save', (req,res)=>{
  try{
    const { number, name, userId } = req.body||{};
    if (!name || !userId) return res.json({ success:false, error:'缺少 name 或 userId' });
    const meta = readJSON(META_FILE);
    const no = String(number || meta.nextNo++);
    meta.map[no] = { name, userId }; writeJSON(META_FILE, meta);
    res.json({ success:true, number:no, data:meta.map[no] });
  }catch(e){ res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/customer-meta/:number', (req,res)=>{
  try{ const no=String(req.params.number), meta=readJSON(META_FILE);
    if (!meta.map[no]) return res.json({ success:false, error:'不存在' });
    delete meta.map[no]; writeJSON(META_FILE, meta); res.json({ success:true });
  }catch(e){ res.status(500).json({ success:false, error:e.message }); }
});

// 模板
app.get('/api/templates', (_req,res)=>{ try{ res.json({ success:true, templates: readJSON(TPL_FILE) }); }catch(e){ res.status(500).json({ success:false, error:e.message }); }});
app.post('/api/templates', (req,res)=>{
  try{ const { content } = req.body||{}; if (!content) return res.json({ success:false, error:'缺少 content' });
    const arr = readJSON(TPL_FILE); arr.push(content); writeJSON(TPL_FILE, arr); res.json({ success:true, templates:arr });
  }catch(e){ res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/templates/:idx', (req,res)=>{
  try{ const idx=parseInt(req.params.idx,10), { content } = req.body||{}, arr=readJSON(TPL_FILE);
    if (!(idx>=0 && idx<arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr[idx]=content||arr[idx]; writeJSON(TPL_FILE, arr); res.json({ success:true, templates:arr });
  }catch(e){ res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/templates/:idx', (req,res)=>{
  try{ const idx=parseInt(req.params.idx,10), arr=readJSON(TPL_FILE);
    if (!(idx>=0 && idx<arr.length)) return res.json({ success:false, error:'索引錯誤' });
    arr.splice(idx,1); writeJSON(TPL_FILE, arr); res.json({ success:true, templates:arr });
  }catch(e){ res.status(500).json({ success:false, error:e.message }); }
});

// ===== 啟動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器運行於 ${PORT}`);
  logger.logToFile(`伺服器運行於 ${PORT}`);
  try { await customerDB.loadAllCustomers(); console.log('✅ 客戶資料載入完成'); }
  catch (e) { console.error('❌ 客戶資料載入失敗:', e.message); }

  // 每日清一次過期 pending
  setInterval(()=> orderManager.cleanExpiredOrders(), 24*60*60*1000);

  // 每 12 小時自動提醒（Flex 訊息）
  setInterval(async ()=>{
    const targets = orderManager.getOrdersNeedingReminder();
    for (const order of targets){
      try{
        orderManager.renewOrder(order.orderId);
        const lp = await createLinePayPayment(order.userId, order.userName, order.amount);
        if (lp.success) orderManager.updatePaymentInfo(order.orderId, lp.transactionId, lp.paymentUrl);
        const ecpayUrl  = `${PUBLIC_BASE}/payment/ecpay/pay/${order.orderId}`;
        const linepayUrl= `${PUBLIC_BASE}/payment/linepay/pay/${order.orderId}`;
        const flex = buildPaymentFlex({ userName:order.userName, amount:order.amount, ecpayUrl, linepayUrl, title:'付款提醒' });
        await client.pushMessage(order.userId, flex);
        orderManager.markReminderSent(order.orderId);
      }catch(e){ logger.logError(`排程提醒失敗: ${order.orderId}`, e); }
    }
  }, 12*60*60*1000);
});
