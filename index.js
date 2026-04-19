// ====== Bootstraps / 基礎設定 ======
require('./bootstrap/storageBridge');
console.log('RAILWAY_VOLUME_MOUNT_PATH =', process.env.RAILWAY_VOLUME_MOUNT_PATH);
// 強制載入 AI 模組以初始化 Google Sheets
console.log('🔧 正在載入 AI 模組...');
require('./services/claudeAI');
console.log('✅ AI 模組已載入');

const { createECPayPaymentLink } = require('./services/openai');
const customerDB = require('./services/customerDatabase');
const fs = require('fs');
const path = require('path'); // ⭐ 新增：用於客戶資料儲存
const express = require('express');
require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');
const logger = require('./services/logger');
const messageHandler = require('./services/message');
// ====== 載入 AI 模組（初始化 Google Sheets）======
console.log('🔧 正在載入 AI 客服模組...');
const claudeAI = require('./services/claudeAI');
console.log('✅ AI 客服模組已載入');
// const { createVideo, waitForVideo } = require('./kling-video');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const { Client } = require('@line/bot-sdk');
const googleAuth = require('./services/googleAuth');
const multer = require('multer');
const orderManager = require('./services/orderManager');
const pickupRoutes = require('./pickupRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const urgentRoutes = require('./routes/urgentRoutes');
const manualRoutes = require('./routes/manualRoutes');
const upload = multer({ storage: multer.memoryStorage() });

// ★ 你的 LIFF ID
const YOUR_LIFF_ID = '2008313382-3Xna6abB';

// ★★★ 強制 HTTPS
function ensureHttpsBase(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return 'https://' + url.replace(/^\/+/, '');
  return url.replace(/^http:/i, 'https:');
}

if (process.env.GOOGLE_PRIVATE_KEY) {
  console.log(`正在初始化 sheet.json: 成功`);
  fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
  console.log(`sheet.json 初始化结束`);
} else {
  console.log(`跳過 sheet.json 初始化 (使用 OAuth 2.0)`);
}

const app = express();
const cors = require('cors');
app.use(cors());

// Volume 資料夾
const FILE_ROOT = '/data/uploads';
fs.mkdirSync(FILE_ROOT, { recursive: true });

// ====== Middleware ======
app.use('/files', express.static(FILE_ROOT));
app.use(express.json({ limit: '50mb' }));  // ⭐ 增加到 50MB
app.use(express.urlencoded({ extended: true, limit: '50mb' }));  // ⭐ 增加到 50MB
app.use(express.static('public'));
app.use('/debug', require('./services/debugStorage'));
app.use('/api/pickup', pickupRoutes.router);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/urgent', urgentRoutes);
app.use('/api/manual', manualRoutes);

// 🚀 最終精確對接版：使用伺服器上實際存在的 pickup-tracking.json
app.post('/api/pos-sync/pickup-complete', async (req, res) => {
    const { customerNo } = req.body; 
    try {
        const fs = require('fs');
        const path = require('path');
        const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
        
        // 🎯 精確指向你在 Logs 看到的正確檔名
        const PICKUP_FILE = path.join(baseDir, 'pickup-tracking.json');

        console.log(`[Sync] 正在對接檔案: ${PICKUP_FILE}`);

        if (!fs.existsSync(PICKUP_FILE)) {
            return res.json({ 
                success: false, 
                message: `對接失敗。雖然目錄有找到，但讀取 ${PICKUP_FILE} 失敗。` 
            });
        }

        let pickupData = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
        
        // 確保編號格式統一：K0000625 -> 625
        const inputNo = parseInt(customerNo.replace(/\D/g, ''), 10); 
        
        // 執行刪除邏輯
        const originalCount = pickupData.orders.length;
        pickupData.orders = pickupData.orders.filter(o => {
            const dbNo = parseInt(String(o.customerNumber).replace(/\D/g, ''), 10);
            return dbNo !== inputNo;
        });
        
        if (pickupData.orders.length < originalCount) {
            fs.writeFileSync(PICKUP_FILE, JSON.stringify(pickupData, null, 2), 'utf8');
            console.log(`✅ 同步成功：已從取件追蹤移除客戶 #${inputNo}`);
            return res.json({ success: true, message: `✅ 成功！通知已取消，已移除編號 ${inputNo}` });
        } else {
            const allNos = pickupData.orders.map(o => o.customerNumber);
            return res.json({ 
                success: false, 
                message: `找到檔案了！但名單中沒看到 ${inputNo}。名單現有：[${allNos.join(', ')}]` 
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 👕 修改這個 API：接收店面電腦的「掛衣進度」
// ==========================================
// 
// 找到你 index.js 裡面的這個 API：
//   app.post('/api/pos-sync/update-progress', ...)
// 
// 把它整個替換成下面這段：

app.post('/api/pos-sync/update-progress', async (req, res) => {
    try {
        const { customerNo, customerName, totalItems, finishedItems, details, lastUpdate } = req.body;
        
        console.log(`[Progress] 收到進度更新: ${customerName} - 客戶編號 ${customerNo} (${finishedItems}/${totalItems})`);

        const fs = require('fs');
        const path = require('path');
        const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
        const PROGRESS_FILE = path.join(baseDir, 'laundry_progress.json');

        // 讀取現有進度表 (如果沒有就創一個空的)
        let progressData = {};
        if (fs.existsSync(PROGRESS_FILE)) {
            progressData = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        }

        // 更新這位客人的資料
        // 用客戶編號當 key（去掉 K, 去掉前導 0）
        const cleanNo = String(customerNo).replace(/\D/g, '').replace(/^0+/, '') || customerNo;
        
        progressData[cleanNo] = {
            total: totalItems,
            finished: finishedItems,
            details: details,  // ["襯衫 (掛衣號:1029)", "POLO衫 (清潔中)"]
            customerName: customerName,  // ⭐ 新增：儲存客戶名稱，用於 LINE 名稱比對
            updateTime: lastUpdate || new Date().toISOString()
        };

        // 寫入檔案
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressData, null, 2), 'utf8');
        
        console.log(`✅ 已更新 ${customerName} (編號:${cleanNo}) 進度: ${finishedItems}/${totalItems}`);

        return res.json({ success: true, message: `已更新客戶 ${customerName} 進度` });

    } catch (err) {
        console.error(`❌ 進度更新失敗: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});


// 🔎 新增功能：讓 AI 查詢進度用的接口
app.get('/api/pos-sync/query-progress/:customerNo', (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
        const PROGRESS_FILE = path.join(baseDir, 'laundry_progress.json');

        if (!fs.existsSync(PROGRESS_FILE)) {
            return res.json({ success: false, message: '尚無進度資料' });
        }

        const progressData = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        const cleanNo = String(req.params.customerNo).replace(/\D/g, '');

        if (progressData[cleanNo]) {
            return res.json({ success: true, data: progressData[cleanNo] });
        } else {
            return res.json({ success: false, message: '找不到此客戶的進度資料' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== 🆕 Fiddler 自動簽收 → 刪除取件追蹤 ==========
app.post('/api/pickup/auto-complete', async (req, res) => {
  const { customerNumber, customerName } = req.body;
  
  console.log(`🧺 收到自動簽收通知: #${customerNumber} - ${customerName}`);
  
  if (!customerNumber) {
    return res.json({ success: false, error: '缺少客戶編號' });
  }
  
  try {
    const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
    const PICKUP_FILE = path.join(baseDir, 'pickup-tracking.json');
    
    let data = { orders: [] };
    if (fs.existsSync(PICKUP_FILE)) {
      data = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
    }
    
    const originalLength = data.orders.length;
    
    // 過濾掉匹配的訂單
    data.orders = data.orders.filter(order => {
      const orderNum = String(order.customerNumber).replace(/^0+/, '') || '0';
      const inputNum = String(customerNumber).replace(/^0+/, '') || '0';
      return orderNum !== inputNum;
    });
    
    const deletedCount = originalLength - data.orders.length;
    
    if (deletedCount > 0) {
      fs.writeFileSync(PICKUP_FILE, JSON.stringify(data, null, 2), 'utf8');
      console.log(`✅ 已刪除 ${deletedCount} 筆取件追蹤: #${customerNumber}`);
    }
    
    res.json({ success: true, deleted: deletedCount });
  } catch (error) {
    console.error('❌ 自動簽收處理失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ========== 🆕 結束 ==========

// ⭐ 新增:載入洗衣軟體同步路由
const posSyncRouter = require('./pos-sync');
app.use('/api/pos-sync', posSyncRouter);

app.delete('/api/pos/payment-record/:rowId', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const auth = new (require('googleapis').google.auth.GoogleAuth)({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;
    const range = `'收款紀錄'!A:G`;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];
    const rowId = decodeURIComponent(req.params.rowId);
    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      // 方法1: orderId 完全比對
      if (r[6] && r[6] === rowId) { targetRow = i + 1; break; }
      // 方法2: date+time+amount 合併比對
      const composed = (r[0]||'').trim() + '_' + (r[1]||'').trim() + '_' + (r[4]||'').toString().trim();
      if (composed === rowId) { targetRow = i + 1; break; }
    }
    if (targetRow === -1) return res.json({ success: false, error: '找不到此紀錄' });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: 209427705, dimension: 'ROWS', startIndex: targetRow - 1, endIndex: targetRow }
          }
        }]
      }
    });
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// POS 收款自動同步
app.post('/api/pos/payment-notify', async (req, res) => {
  try {
    const { date, time, customerName, amount, paymentMethod, orderId } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.json({ success: false, error: '金額無效' });

    const { google } = require('googleapis');
    const auth = new (require('googleapis').google.auth.GoogleAuth)({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    // 防止重複
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'收款紀錄'!A:G` });
    const rows = existing.data.values || [];
    if (orderId && rows.some(r => r[6] && r[6].includes(orderId))) {
      return res.json({ success: true, message: '已存在' });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'收款紀錄'!A:G`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, time, customerName || '未知', '', parseFloat(amount), paymentMethod || '其他', orderId || '']] }
    });

    console.log(`✅ POS收款同步：${customerName} NT$${amount} ${paymentMethod}`);
    res.json({ success: true });
  } catch (error) {
    console.error('POS收款錯誤:', error);
    res.json({ success: false, error: error.message });
  }
});

// 查詢收款統計
app.get('/api/pos/payment-summary', async (req, res) => {
  try {
    const { month } = req.query;
    const { google } = require('googleapis');
    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'收款紀錄'!A:G` });
    const rows = (response.data.values || []).slice(1);

    const records = [];
    const methodTotals = {};
    const dailyTotals = {};
    let totalCollected = 0;

    rows.forEach(row => {
      if (month) {
        const [y, m] = month.split('-');
        if (!row[0]) return;
const rowDate = row[0].toString().replace(/\//g, '-').split('-');
if (rowDate.length < 3) return;
const rowYear = rowDate[0];
const rowMonth = rowDate[1].padStart(2, '0');
if (rowYear !== y || rowMonth !== m.padStart(2, '0')) return;
      }
      const amount = parseFloat(row[4] || 0);
      const method = row[5] || '其他';
      const dayKey = (row[0] || '').replace(/\//g, '-').substring(0, 10);

      records.push({ date: row[0], time: row[1], customerName: row[2], amount, paymentMethod: method });
      methodTotals[method] = (methodTotals[method] || 0) + amount;
      dailyTotals[dayKey] = (dailyTotals[dayKey] || 0) + amount;
      totalCollected += amount;
    });

    const dailyArray = Object.entries(dailyTotals).map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, records: records.reverse(), summary: { totalCollected, methodTotals, dailyTotals: dailyArray, count: records.length } });
  } catch (error) {
    res.json({ success: false, error: error.message, records: [], summary: {} });
  }
});

// ====== POS 自動綁定客戶編號 ======
function extractCustomerNo(raw) {
  if (!raw) return null;
  const match = String(raw).match(/(\d+)$/);
  return match ? String(parseInt(match[1], 10)) : null;
}

async function getPosToken() {
  const res = await fetch('http://yidianyuan.ao-lan.cn/wepapi/User/Login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ LoginName: 'ch', LoginPwd: 'admin' })
  });
  const data = await res.json();
  return data?.data?.token ?? null;
}

async function autoLookupAndBind(userId, displayName) {
  try {
    const token = await getPosToken();
    if (!token) return null;

    let res = await fetch('http://yidianyuan.ao-lan.cn/wepapi/Customer/SearchCustomer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ KeyWord: userId })
    });
    let data = await res.json();
    let results = data?.data ?? [];

    if (results.length === 1) {
      console.log(`[AutoBind] 方法1(userId)命中`);
      return extractCustomerNo(results[0].CustomerNo);
    }

    res = await fetch('http://yidianyuan.ao-lan.cn/wepapi/Customer/SearchCustomer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ KeyWord: displayName })
    });
    data = await res.json();
    results = data?.data ?? [];

    if (results.length === 1) {
      console.log(`[AutoBind] 方法2(displayName)命中`);
      return extractCustomerNo(results[0].CustomerNo);
    }

    return null;
  } catch (e) {
    console.error('[AutoBind] 錯誤:', e.message);
    return null;
  }
}


// ====== LINE Client ======
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

async function saveUserProfile(userId) {
  try {
    const profile = await client.getProfile(userId);
    await customerDB.saveCustomer(userId, profile.displayName);
  } catch (error) {
    logger.logError('記錄用戶資料失敗', error, userId);
  }
}

// ====== 使用者資料 API ======
app.get('/api/users', (req, res) => {
  const users = customerDB.getAllCustomers();
  res.json({ total: users.length, users: users });
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
    res.json({ success: true, message: '名稱已更新', user: user });
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

// ⭐ 客人紀錄 API - 取得所有紀錄
app.get('/api/customer-records', (req, res) => {
  try {
    const customers = customerDB.getAllCustomers();
    
    // 計算統計資訊
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneWeekMs = 7 * oneDayMs;
    
    let todayCount = 0;
    let weekCount = 0;
    
    customers.forEach(customer => {
      if (customer.firstContact) {
        const diff = now - new Date(customer.firstContact).getTime();
        if (diff <= oneDayMs) todayCount++;
        if (diff <= oneWeekMs) weekCount++;
      }
    });
    
    res.json({
      success: true,
      total: customers.length,
      records: customers,
      statistics: {
        total: customers.length,
        today: todayCount,
        week: weekCount
      }
    });
  } catch (error) {
    console.error('取得客人紀錄失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ⭐ 客人紀錄 API - 取得單一客人詳情
app.get('/api/customer-records/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const customer = customerDB.getCustomer(userId);
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        error: '找不到此客人'
      });
    }
    
    res.json({
      success: true,
      record: customer
    });
  } catch (error) {
    console.error('取得客人詳情失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ====== LINE Pay 設定 ======
const LINE_PAY_CONFIG = {
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
  env: process.env.LINE_PAY_ENV || 'production',
  apiUrl: process.env.LINE_PAY_ENV === 'sandbox'
    ? 'https://sandbox-api-pay.line.me'
    : (process.env.LINE_PAY_API_URL || 'https://api-pay.line.me')
};

function generateLinePaySignature(uri, body, nonce) {
  const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
  return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret).update(message).digest('base64');
}

// ====== HTML 渲染 ======
function renderErrorPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}
h1{font-size:28px;margin-bottom:16px}
p{font-size:16px;line-height:1.6}
</style>
</head><body>
<div class="container">
  <h1>Warning: ${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

function renderLinePayPage(orderId, amount, remainingHours, paymentUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LINE Pay 付款</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:40px;background:linear-gradient(135deg,#06C755,#00B900);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:28px;max-width:480px;margin:0 auto;box-shadow:0 8px 32px rgba(0,0,0,0.2)}
h1{font-size:26px;margin-bottom:20px;font-weight:700}
.info{background:rgba(255,255,255,0.2);border-radius:12px;padding:16px;margin:20px 0;font-size:15px}
.btn{display:inline-block;width:90%;padding:18px;background:#fff;color:#06C755;text-decoration:none;border-radius:12px;font-weight:700;margin-top:20px;font-size:18px;border:none;box-shadow:0 4px 12px rgba(0,0,0,0.15)}
.btn:active{transform:scale(0.95)}
.note{font-size:13px;opacity:0.9;margin-top:16px;line-height:1.5}
.warning{background:rgba(255,200,0,0.25);padding:12px;border-radius:8px;margin:16px 0;font-size:14px;line-height:1.5}
</style>
</head><body>
<div class="container">
  <h1>LINE Pay 付款</h1>
  <div class="info">
    <div>訂單: ${orderId}</div>
    <div style="font-size:24px;font-weight:700;margin:12px 0">NT$ ${amount.toLocaleString()}</div>
    <div>有效期: ${remainingHours} 小時</div>
  </div>
  <div class="warning">Warning: 點擊按鈕後將前往 LINE Pay 完成付款，完成後系統會自動通知。</div>
  <a href="${paymentUrl}" class="btn">前往 LINE Pay 付款</a>
  <p class="note">請勿重複點擊；若已付款，稍後會收到成功通知。</p>
</div>
</body></html>`;
}

// ====== 建立 LINE Pay 交易 ======
async function createLinePayPayment(userId, userName, amount, orderIdOverride) {
  try {
     const orderId = orderIdOverride || `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    const confirmUrl = `${baseURL}/payment/linepay/confirm?parentOrderId=${encodeURIComponent(orderId)}`;
    const cancelUrl  = `${baseURL}/payment/linepay/cancel?parentOrderId=${encodeURIComponent(orderId)}`;

    logger.logToFile(`[DEBUG] 建立 LINE Pay 交易，confirmUrl=${confirmUrl}`);

    const requestBody = {
      amount: amount,
      currency: 'TWD',
      orderId: orderId,
      packages: [{
        id: orderId,
        amount: amount,
        name: 'C.H精緻洗衣服務',
        products: [{ name: '洗衣清潔費用', quantity: 1, price: amount }]
      }],
      redirectUrls: { confirmUrl, cancelUrl }
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
    logger.logToFile(`LINE Pay API: ${result.returnCode} - ${result.returnMessage}`);

    if (result.returnCode === '0000') {
      const paymentUrlApp = result.info?.paymentUrl?.app || null;
      const paymentUrlWeb = result.info?.paymentUrl?.web || null;
      const txId = result.info?.transactionId || null;
      const pickUrl = paymentUrlApp || paymentUrlWeb;

      return {
        success: true,
        paymentUrlApp,
        paymentUrlWeb,
        paymentUrl: pickUrl,
        orderId,
        transactionId: txId
      };
    } else {
      return { success: false, error: result.returnMessage || '請求失敗' };
    }
  } catch (error) {
    logger.logError('LINE Pay 請求錯誤', error);
    return { success: false, error: error.message };
  }
}
// ====== Webhook (全功能整合版：含超強關鍵字查詢) ======
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // 先回覆 LINE Server 200 OK

  try {
    const events = req.body.events;
    for (const event of events) {
      try {
        if (event.type !== 'message' || !event.source.userId) continue;
        const userId = event.source.userId;
        
        // 1. 取得真實名字 & 更新資料
        let realName = "貴賓";
        try {
            const profile = await client.getProfile(userId);
            realName = profile.displayName ? profile.displayName.trim() : "貴賓";
        } catch (e) {}

        await saveUserProfile(userId);
        try {
          await customerDB.updateCustomerActivity(userId, event.message);
        } catch (err) {}

        // ====== 自動綁定 POS 客戶編號 ======
const existingCustomer = orderManager.getAllCustomerNumbers()
  .find(c => c.userId === userId);

if (!existingCustomer) {
  // 這個用戶還沒有綁定編號，嘗試自動查詢
  try {
    const foundNo = await autoLookupAndBind(userId, realName);
    if (foundNo) {
      orderManager.saveCustomerNumber(foundNo, realName, userId);
      console.log(`[AutoBind] ✅ ${realName} 自動綁定編號: ${foundNo}`);
    }
  } catch (e) {
    console.error('[AutoBind] 錯誤:', e.message);
  }
}
        
        // ========== 處理文字訊息 ==========
        if (event.message.type === 'text') {
          const userMessage = event.message.text.trim();
          logger.logUserMessage(userId, userMessage);

          // (A0) 廣告影片指令
if (userMessage.startsWith('產生廣告') || userMessage.startsWith('生成廣告')) {
  const topic = userMessage.replace(/產生廣告|生成廣告/g, '').trim() || null;
  await client.pushMessage(userId, {
    type: 'text',
    text: topic
      ? `🎬 收到！正在為「${topic}」生成廣告影片，約需 5-10 分鐘，完成後會推播給你。`
      : `🎬 收到！正在自動發想今日廣告主題並生成影片，約需 5-10 分鐘，完成後會推播給你。`
  });
  generateDailyAdVideo(topic).catch(err => console.error('廣告影片錯誤:', err));
  continue;
}
          
          // (A) 特殊指令：按 1 直接給 messageHandler
          if (userMessage === '1' || userMessage === '１') {
            await messageHandler.handleTextMessage(userId, userMessage, userMessage);
            continue;
          }

          // (B) 🔎 進度查詢功能 (超完整關鍵字版)
          // 只要客人說出這些詞，機器人就會去查進度，不會讓 AI 亂回覆
          const queryKeywords = [
    '進度', '查詢', '查單', '好了沒', '好了嗎',
    '洗好了', '洗完了', '完成了', 'ok了', 'OK了',
    '幫我查', '幫我看', '幫查',
    '還沒好', '還沒洗', '還在洗',
    '我的衣服', '衣服呢', '好了没'
];

const queryExcludeKeywords = [
    '營業', '幾點開', '幾點到幾點', '幾點前要', '幾點前拿',
    '送回來', '什麼時候送', '什麼時候來收', '可以來收',
    '最快', '多久送', '收件', '收衣服', '幾點前'
];

const isQueryIntent = queryKeywords.some(k => userMessage.includes(k)) &&
    !queryExcludeKeywords.some(k => userMessage.includes(k));
          if (isQueryIntent) {
              console.log(`🔍 [查詢] ${realName} 正在查詢...`);
              const fs = require('fs');
              const path = require('path');
              const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
              const PROGRESS_FILE = path.join(baseDir, 'laundry_progress.json');

              let foundItems = [];
              if (fs.existsSync(PROGRESS_FILE)) {
                  try {
                      const progressData = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
                      // 移除空白後比對名字
                      const cleanRealName = realName.replace(/\s/g, ''); 
                      for (const key in progressData) {
                          const data = progressData[key];
                          const dbName = data.customerName || "";
                          const cleanDbName = dbName.replace(/\s/g, ''); 
                          // 名字比對邏輯
                          if (cleanDbName && cleanRealName && (cleanDbName.includes(cleanRealName) || cleanRealName.includes(cleanDbName))) {
                              console.log(`✅ 匹配成功: ${dbName}`);
                              if (Array.isArray(data.details)) {
                                  foundItems = data.details.map(d => {
                                      const isFin = d.includes('掛衣號');
                                      return { txt: d, isFin };
                                  });
                              }
                              break;
                          }
                      }
                  } catch (e) { console.error('讀檔失敗', e); }
              }

              if (foundItems.length > 0) {
                  // --- 查到了 (顯示進度) ---
                  const finished = foundItems.filter(i => i.isFin).length;
                  const processing = foundItems.length - finished;
                  
                  let reply = `${realName} 您好 💙 幫您查到了！\n`;
                  reply += `您這次送洗共有 ${foundItems.length} 件，其中 ${finished} 件已經清洗完成 ✨\n\n`;
                  
                  reply += `目前進度如下：\n`;
                  foundItems.forEach(item => { 
                      reply += item.isFin ? `✅ ${item.txt}\n` : `⏳ ${item.txt}\n`; 
                  });
                  
                  if (processing > 0) {
                      reply += `\n還有 ${processing} 件正在努力清潔中，好了會立即通知您喔 💙`;
                  } else {
                      reply += `\n全部都洗好囉！歡迎來店取件 💙`;
                  }
                  
                  reply += `\n\n您也可以點此查看詳情 🔍\nhttps://liff.line.me/2004612704-JnzA1qN6#/home`;
                  
                  await client.pushMessage(userId, { type: 'text', text: reply });
              } else {
                  // --- 沒查到 (顯示官方制式訊息) ---
                  const defaultReply = `您可以線上查詢 C.H精緻洗衣 🔍\nhttps://liff.line.me/2004612704-JnzA1qN6#/home\n或是營業時間會有專人回覆您，謝謝 🙏`;
                  await client.pushMessage(userId, { type: 'text', text: defaultReply });
              }
              continue; // 成功攔截查詢，跳過後面的 AI，不讓 AI 插嘴
          }

          // (C) 🤖 Claude AI 優先處理 (非查詢類問題)
          let claudeReplied = false;
          let aiResponse = '';
          try {
            aiResponse = await claudeAI.handleTextMessage(userMessage, userId);
            if (aiResponse) {
              await client.pushMessage(userId, { type: 'text', text: aiResponse });
              logger.logToFile(`[Claude AI] 已回覆: ${userId}`);
              claudeReplied = true;
            }
          } catch (err) { logger.logError('[Claude AI] 失敗', err); }

          if (!claudeReplied) {
            await messageHandler.handleTextMessage(userId, userMessage, userMessage);
          }

          // (D) 🧺 收件偵測 (保留您原本的功能)
          const pickupKeywords = ['會去收', '去收回', '來收', '過去收', '收衣服', '明天收', '今天收', '收取', '安排收件', '會過去收', '可以來收', '去拿', '會來收'];
          const containsPickup = (msg) => pickupKeywords.some(k => msg.includes(k));

          // 檢查客人訊息
          if (containsPickup(userMessage)) {
              try {
                const allCustomers = orderManager.getAllCustomerNumbers();
                const cData = allCustomers.find(c => c.userId === userId);
                const cNum = cData ? cData.number : '未登記';
                await fetch(`${process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app'}/api/pickup-schedule/auto-add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, userName: realName, message: userMessage, source: 'customer', customerNumber: cNum })
                });
              } catch(e) {}
          }
          // 檢查 AI 回覆
          if (claudeReplied && aiResponse && containsPickup(aiResponse)) {
             try {
                const allCustomers = orderManager.getAllCustomerNumbers();
                const cData = allCustomers.find(c => c.userId === userId);
                const cNum = cData ? cData.number : '未登記';
                await fetch(`${process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app'}/api/pickup-schedule/auto-add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, userName: realName, message: aiResponse, source: 'ai', customerNumber: cNum })
                });
             } catch(e) {}
          }

        } else if (event.message.type === 'image') {
          await messageHandler.handleImageMessage(userId, event.message.id);
        } else if (event.message.type === 'sticker') {
          logger.logUserMessage(userId, `發送了貼圖 (${event.message.stickerId})`);
        }
      } catch (err) {
        logger.logError('處理事件出錯', err);
      }
    }
  } catch (err) {
    logger.logError('全局錯誤', err);
  }
});

// 🗑️ 刪除過期的 Google token
app.get('/auth/reset', (req, res) => {
  try {
    const fs = require('fs');
    const tokenPath = '/data/google-token.json';
    
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
      console.log('✅ 已刪除舊的 token 檔案');
      res.send(`
        <h2>✅ Token 已清除</h2>
        <p>請點擊下方連結重新授權：</p>
        <a href="/auth" style="font-size:20px; padding:10px 20px; background:#4285f4; color:white; text-decoration:none; border-radius:5px;">
          🔐 重新授權 Google Sheets
        </a>
      `);
    } else {
      res.send(`
        <h2>ℹ️ 沒有找到 token 檔案</h2>
        <p>請直接進行授權：</p>
        <a href="/auth" style="font-size:20px; padding:10px 20px; background:#4285f4; color:white; text-decoration:none; border-radius:5px;">
          🔐 授權 Google Sheets
        </a>
      `);
    }
  } catch (error) {
    console.error('刪除 token 錯誤:', error);
    res.status(500).send(`錯誤: ${error.message}`);
  }
});

// ====== Google OAuth ======
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
  if (!code) return res.status(400).send('缺少擔保碼');
  try {
    await googleAuth.getTokenFromCode(code);
    logger.logToFile('Google OAuth 授權成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>授權成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}</style></head><body><div class="container"><h1>授權成功!</h1><p>Google Sheets 和 Drive 已成功連接</p><p>您可以關閉此視窗了</p></div></body></html>');
  } catch (error) {
    logger.logError('處理擔保碼失敗', error);
    res.status(500).send('授權失敗: ' + error.message);
  }
});

app.get('/auth/status', (req, res) => {
  const isAuthorized = googleAuth.isAuthorized();
  res.json({ authorized: isAuthorized, message: isAuthorized ? '已授權' : '未授權' });
});

app.get('/test-sheets', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    if (!googleAuth.isAuthorized()) {
      return res.send('尚未完成 OAuth 授權!<br><a href="/auth">點此進行授權</a>');
    }
    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;
    if (!spreadsheetId) {
      return res.send('請在 .env 中設定 GOOGLE_SHEETS_ID_CUSTOMER');
    }
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:E',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[timestamp, 'OAuth 測試客戶', 'test@example.com', '測試地址', 'OAuth 2.0 寫入測試成功!']] }
    });
    logger.logToFile('Google Sheets OAuth 測試成功');
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試成功</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:600px;margin:0 auto}h1{font-size:32px;margin-bottom:20px}a{color:#fff;text-decoration:underline}</style></head><body><div class="container"><h1>Google Sheets 寫入測試成功!</h1><p>已成功使用 OAuth 2.0 寫入資料到試算表</p><p>寫入時間: ' + timestamp + '</p><p><a href="https://docs.google.com/spreadsheets/d/' + spreadsheetId + '" target="_blank">點此查看試算表</a></p><p><a href="/">返回首頁</a></p></div></body></html>');
  } catch (error) {
    logger.logError('Google Sheets 測試失敗', error);
    res.status(500).send(`測試失敗: ${error.message}<br><a href="/auth">重新授權</a>`);
  }
});

app.get('/test-upload', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>測試上傳</title></head><body><h1>測試上傳功能已停用</h1></body></html>');
});

app.post('/api/test-upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '沒有收到圖片' });
    const type = req.body.type || 'before';
    const { customerLogService } = require('./services/multiSheets');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const typeLabel = type === 'after' ? '洗後' : '洗前';
    const filename = `${typeLabel}_test_${timestamp}.jpg`;
    const result = await customerLogService.uploadImageToDrive(req.file.buffer, filename, type);
    if (result.success) {
      logger.logToFile(`${typeLabel}測試上傳成功: ${filename}`);
      res.json({ success: true, fileId: result.fileId, viewLink: result.viewLink, downloadLink: result.downloadLink });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.logError('測試上傳失敗', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/log', (req, res) => {
  res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
    if (err) {
      logger.logError('下載日誌文件出錯', err);
      res.status(500).send('下載文件失敗');
    }
  });
});

app.get('/test-push', async (req, res) => {
  const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx";
  try {
    await client.pushMessage(userId, { type: 'text', text: '測試推播成功!這是一則主動訊息' });
    res.send("推播成功,請查看 LINE Bot 訊息");
  } catch (err) {
    console.error("推播錯誤", err);
    res.status(500).send(`推播失敗: ${err.message}`);
  }
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

app.all('/payment/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>付款成功</title>
  <style>
    body {
      font-family: sans-serif;
      text-align: center;
      padding: 50px 20px;
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      color: white;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 20px;
      padding: 40px;
      max-width: 500px;
      margin: 0 auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .success-icon {
      font-size: 80px;
      margin-bottom: 20px;
      animation: scaleIn 0.5s ease-out;
    }
    @keyframes scaleIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }
    h1 {
      color: #fff;
      font-size: 48px;
      margin: 20px 0;
      font-weight: bold;
    }
    p {
      font-size: 20px;
      line-height: 1.6;
      margin: 15px 0;
    }
    .highlight {
      background: rgba(255, 255, 255, 0.25);
      padding: 20px;
      border-radius: 12px;
      margin: 25px 0;
      font-size: 18px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✅</div>
    <h1>付款成功！</h1>
    <div class="highlight">
      <p><strong>感謝您的支付</strong></p>
      <p>我們已收到您的付款</p>
    </div>
    <p style="font-size: 16px; opacity: 0.9;">
      系統會自動通知我們<br>
      您可以關閉此頁面了
    </p>
  </div>
</body>
</html>`);
});

// ====== 綠界持久付款頁 ======
app.get('/payment/ecpay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單不存在</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>訂單不存在</h1><p>找不到此訂單</p></div></body></html>');
  }

  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}</style></head><body><div class="container"><h1>訂單已過期</h1><p>此訂單已超過 7 天(168 小時)</p><p>已過時間: ' + Math.floor(hoursPassed) + ' 小時</p><p>訂單編號: ' + orderId + '</p><p>請聯繫 C.H 精緻洗衣客服重新取得訂單</p></div></body></html>');
  }

  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>訂單已付款</h1><p>此訂單已完成付款</p><p>訂單編號: ' + orderId + '</p></div></body></html>');
  }

  try {
    logger.logToFile(`重新生成綠界付款連結: ${orderId}`);
    const ecpayLink = createECPayPaymentLink(order.userId, order.userName, order.amount);
    const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>前往綠界付款</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#667eea,#764ba2);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}h1{font-size:28px;margin-bottom:20px}p{font-size:16px;margin:15px 0}.btn{display:inline-block;padding:15px 40px;background:#fff;color:#667eea;text-decoration:none;border-radius:10px;font-weight:bold;margin-top:20px;font-size:18px}.info{background:rgba(255,255,255,0.2);padding:15px;border-radius:10px;margin:20px 0}</style></head><body><div class="container"><h1>前往綠界付款</h1><div class="info"><p><strong>訂單編號:</strong> ' + orderId + '</p><p><strong>客戶姓名:</strong> ' + order.userName + '</p><p><strong>金額:</strong> NT$ ' + order.amount.toLocaleString() + '</p><p><strong>剩餘有效時間:</strong> ' + remainingHours + ' 小時</p></div><p>正在為您生成付款連結...</p><p>若未自動跳轉，請點擊下方按鈕</p><a href="' + ecpayLink + '" class="btn">立即前往綠界付款</a></div><script>setTimeout(function(){window.location.href="' + ecpayLink + '"},1500)</script></body></html>');
    logger.logToFile(`綠界付款連結已重新生成: ${orderId}`);
  } catch (error) {
    logger.logError('重新生成綠界連結失敗', error);
    res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>生成失敗</title></head><body><h1>付款連結生成失敗</h1><p>請聯繫客服處理</p></body></html>');
  }
});

// ====== 綠界付款結果通知 (只更新為已付款，不動其他功能) ======
app.post('/payment/ecpay/notify', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const data = req.body;
    const orderId = data.MerchantTradeNo;
    const rtnCode = data.RtnCode;

    logger.logToFile(`[ECPAY][NOTIFY] 收到通知: ${JSON.stringify(data)}`);

    // ✅ 若付款成功 (rtnCode=1)
    if (rtnCode === '1' || rtnCode === 1) {
      const order = orderManager.getOrder(orderId);
      if (order && order.status !== 'paid') {
        order.status = 'paid';
        orderManager.saveOrders();
        logger.logToFile(`[ECPAY][SUCCESS] 訂單 ${orderId} 狀態更新為已付款`);
      }
    }

    // ✅ 綠界要求回傳 "1|OK" 表示接收成功
    res.send('1|OK');
  } catch (err) {
    logger.logError('ECPAY 通知處理錯誤', err);
    res.send('0|ERROR');
  }
});


// ====== LINE Pay 持久付款頁 ======
const creatingTransactions = new Set();

app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) {
    return res.status(404).send(renderErrorPage('訂單不存在', '找不到此訂單'));
  }
  if (orderManager.isExpired(orderId)) {
    const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
    logger.logToFile(`訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
    return res.send(renderErrorPage('訂單已過期', `此訂單已超過 7 天<br>訂單編號: ${orderId}`));
  }
  if (order.status === 'paid') {
    return res.send(renderErrorPage('訂單已付款', `此訂單已完成付款<br>訂單編號: ${orderId}`));
  }

  try {
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        logger.logToFile(`重用既有連結: ${orderId}（${Math.floor(elapsed / 1000)} 秒前建立）`);
        const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
        return res.send(renderLinePayPage(orderId, order.amount, remainingHours, order.linepayPaymentUrl));
      }
    }

    if (creatingTransactions.has(orderId)) {
      logger.logToFile(`建立中: ${orderId}，等待 1 秒再查`);
      await new Promise(r => setTimeout(r, 1000));
      const fresh = orderManager.getOrder(orderId);
      if (fresh.linepayTransactionId && fresh.linepayPaymentUrl) {
        const elapsed2 = Date.now() - (fresh.lastLinePayRequestAt || 0);
        if (elapsed2 < 15 * 60 * 1000) {
          logger.logToFile(`使用剛建立的連結: ${orderId}`);
          const remainingHours = Math.floor((fresh.expiryTime - Date.now()) / (1000 * 60 * 60));
          return res.send(renderLinePayPage(orderId, fresh.amount, remainingHours, fresh.linepayPaymentUrl));
        }
      }
      return res.status(503).send(renderErrorPage('付款連結建立中', '正在為您建立付款連結<br>請稍候 2 秒後重新整理'));
    }

    creatingTransactions.add(orderId);
    try {
      logger.logToFile(`建立新 LINE Pay 交易: ${orderId}`);
      const lp = await createLinePayPayment(order.userId, order.userName, order.amount, orderId);
      if (!lp.success) {
        return res.status(500).send(renderErrorPage('生成失敗', lp.error || '無法建立付款連結'));
      }

      const urlApp = lp.paymentUrlApp || null;
      const urlWeb = lp.paymentUrlWeb || null;
      const urlAny = urlApp || urlWeb || lp.paymentUrl;

      orderManager.updatePaymentInfo(orderId, {
        linepayTransactionId: lp.transactionId,
        linepayPaymentUrl: urlAny,
        linepayPaymentUrlApp: urlApp,
        linepayPaymentUrlWeb: urlWeb,
        lastLinePayRequestAt: Date.now()
});

const ua = String(req.headers['user-agent'] || '');
const preferApp = /Line\/|LineApp/i.test(ua); // 判斷是否在 LINE App 內
const chosenUrl = preferApp ? (urlApp || urlAny) : (urlWeb || urlAny);

const remainingHours = Math.floor((order.expiryTime - Date.now()) / (1000 * 60 * 60));
return res.send(renderLinePayPage(orderId, order.amount, remainingHours, chosenUrl));

    } finally {
      creatingTransactions.delete(orderId);
    }
  } catch (error) {
    creatingTransactions.delete(orderId);
    logger.logError('LINE Pay 付款頁面錯誤', error);
    return res.status(500).send(renderErrorPage('系統錯誤', '請稍後重試或聯繫客服'));
  }
});

/* ========= LINE Pay 背景確認處理 ========= */
async function handleLinePayConfirm(transactionId, orderId, parentOrderId) {
  logger.logToFile(`[LINEPAY][CONFIRM] 開始處理：tx=${transactionId} parent=${parentOrderId} order=${orderId}`);

  let order = null;
  if (parentOrderId) order = orderManager.getOrder(parentOrderId);
  if (!order && transactionId) {
    const all = orderManager.getAllOrders();
    for (const o of Object.values(all)) {
      if (o.linepayTransactionId === transactionId && o.status === 'pending') {
        order = o;
        break;
      }
    }
  }
  if (!order && orderId) order = orderManager.getOrder(orderId);
  if (!order) {
    logger.logToFile(`[LINEPAY][CONFIRM] 訂單不存在`);
    return;
  }

  if (orderManager.isExpired(order.orderId) || order.status === 'paid') {
    logger.logToFile(`[LINEPAY][CONFIRM] 訂單已過期或已付款`);
    return;
  }

  try {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = `/v3/payments/${transactionId}/confirm`;
    const body = { amount: order.amount, currency: 'TWD' };
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
      orderManager.updateOrderStatus(order.orderId, 'paid', 'LINE Pay');
      logger.logToFile(`[LINEPAY][SUCCESS] ${order.orderId} 付款成功`);

      // 寫入收款紀錄
try {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '/');
  const timeStr = now.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID_CUSTOMER,
    range: `'收款紀錄'!A:G`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[dateStr, timeStr, order.userName || '未知', '', parseFloat(order.amount), 'LINE Pay', order.orderId]] }
  });
  console.log(`✅ LINE Pay 收款紀錄已寫入`);
} catch(e) { console.error('寫入收款紀錄失敗:', e.message); }

    // 🔥🔥🔥 【請貼在這裡：LINE Pay 成功後加入同步清單】 🔥🔥🔥
    if (global.pendingSyncOrders) {
         global.pendingSyncOrders.push({
              orderId: order.orderId,  // ⚠️ 請確認這裡的 orderId 是對應到洗衣店的單號 (例如 001005680)
              amount: order.amount,
              payType: 'LINE'
          });
          console.log(`[Payment] LINE Pay 訂單 ${order.orderId} 已加入同步佇列`);
      }
      // 🔥🔥🔥 【結束】 🔥🔥🔥
      
      if (process.env.ADMIN_USER_ID) {
        client.pushMessage(process.env.ADMIN_USER_ID, {
          type: 'text',
          text: `收到 LINE Pay 付款通知\n\n客戶姓名:${order.userName}\n付款金額:NT$ ${order.amount.toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${order.orderId}\n交易編號:${transactionId}\n\n狀態:付款成功`
        }).catch(() => {});
      }

      if (order.userId && order.userId !== 'undefined') {
        client.pushMessage(order.userId, {
          type: 'text',
          text: `✅ LINE Pay 付款成功\n\n感謝 ${order.userName} 的支付\n金額:NT$ ${order.amount.toLocaleString()}\n訂單編號:${order.orderId}\n\n非常謝謝您\n感謝您的支持 💙`
        }).catch(() => {});
      }
    } else {
      logger.logToFile(`[LINEPAY][FAIL] Confirm 失敗: ${result.returnCode} - ${result.returnMessage}`);
    }
  } catch (error) {
    logger.logError('Confirm 處理失敗', error);
  }
}

// ====== 綠界 ReturnURL（伺服器背景通知）======
// 支援 POST / GET；為避免綠界重試，先回 "1|OK"（若你想嚴謹驗章後再回，也可移到成功分支最後）
function generateECPayCheckMacValue(params) {
  const { ECPAY_HASH_KEY, ECPAY_HASH_IV } = process.env;
  const data = { ...params };
  delete data.CheckMacValue;

  const sortedKeys = Object.keys(data).sort();
  let raw = `HashKey=${ECPAY_HASH_KEY}`;
  sortedKeys.forEach((k) => { raw += `&${k}=${data[k]}`; });
  raw += `&HashIV=${ECPAY_HASH_IV}`;

  raw = encodeURIComponent(raw)
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .toLowerCase();

  return require('crypto')
    .createHash('sha256')
    .update(raw)
    .digest('hex')
    .toUpperCase();
}

// ====== 綠界 ReturnURL (伺服器背景通知) [已修復] ======
app.all('/payment/ecpay/callback', async (req, res) => {
  try {
    // 1) 先回覆綠界，避免重試
    res.type('text').send('1|OK');

    // 2) 取得回傳資料
    const data = { ...req.body, ...req.query };

    // 3) 驗證 CheckMacValue
    const mac = String(data.CheckMacValue || '');
    const calc = generateECPayCheckMacValue(data);
    if (!mac || mac.toUpperCase() !== calc.toUpperCase()) {
      logger.logToFile('[ECPAY][WARN] CheckMacValue 不一致');
      return; 
    }

    // 4) 僅在成功時處理
    if (String(data.RtnCode) !== '1') {
      logger.logToFile(`[ECPAY][INFO] 非成功回傳：RtnCode=${data.RtnCode}`);
      return;
    }

    // 5) 記錄日誌與通知
    const merchantTradeNo = data.MerchantTradeNo;
    const amount = Number(data.TradeAmt || data.Amount || 0);
    const payType = data.PaymentType || 'ECPay';
    const userId = data.CustomField1 || '';
    const userName = data.CustomField2 || '';

    // ✅【更新訂單狀態】Bug Fix: 改用 orderId 精準比對，userName 移至前面宣告
    const allOrders = orderManager.getAllOrders();
    for (const order of allOrders) {
      const oid = order.orderId;
      if (
        oid === merchantTradeNo &&
        order.status !== 'paid'
      ) {
        orderManager.updateOrderStatus(oid, 'paid', 'ECPay');
        logger.logToFile(`[ECPAY][UPDATE] 訂單 ${oid} 狀態更新為已付款`);

        // 寫入收款紀錄
try {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '/');
  const timeStr = now.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID_CUSTOMER,
    range: `'收款紀錄'!A:G`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[dateStr, timeStr, userName || '未知', '', parseFloat(amount), '信用卡', oid]] }
  });
  console.log(`✅ ECPay 收款紀錄已寫入`);
} catch(e) { console.error('寫入收款紀錄失敗:', e.message); }

        // 🔥 通知店裡電腦 (同步清單)
        if (global.pendingSyncOrders) {
            global.pendingSyncOrders.push({
                orderId: oid,
                amount: Number(order.amount),
                payType: 'CREDIT'
            });
            console.log(`[Payment] 綠界訂單 ${oid} 已加入同步佇列`);
        }
        break;
      }
    }

    logger.logToFile(`[ECPAY][SUCCESS] ${merchantTradeNo} 成功 NT$${amount}`);

    if (process.env.ADMIN_USER_ID) {
      client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: `✅ 綠界付款成功\n客戶：${userName}\n金額：NT$ ${amount}`
      }).catch(() => {});
    }

    if (userId && userId !== 'undefined') {
      client.pushMessage(userId, {
        type: 'text',
        text: `✅ 付款成功（綠界）\n感謝您的支持 💙`
      }).catch(() => {});
    }
  } catch (err) {
    logger.logError('[ECPAY][ERROR] 回調處理失敗', err);
  }
});

// ====== Line Pay Confirm (付款確認頁面) [已修復] ======
app.all('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId, parentOrderId } = { ...req.query, ...req.body };
  
  // 顯示成功頁面
  res.status(200).send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>付款成功</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 50px 20px; background: #06C755; color: white; }
    h1 { font-size: 32px; font-weight: bold; }
  </style>
</head>
<body>
  <h1>✅ 付款成功！</h1>
  <p>LINE Pay 付款已完成，感謝您的支持。</p>
</body>
</html>
  `);

  // 背景處理確認
  setImmediate(() => {
    handleLinePayConfirm(transactionId, orderId, parentOrderId).catch(() => {});
  });
});
// 🔥 在這裡加入手動觸發 API（開始）🔥
app.get('/api/generate-weekly-report', async (req, res) => {
  try {
    console.log('🔍 手動觸發週報生成...');
    
    const weeklyAnalysis = require('./services/weeklyAnalysis');
    const reportGenerator = require('./services/reportGenerator');
    
    // 1. 分析數據
    const analysis = await weeklyAnalysis.analyzeWeeklyData();
    
    if (!analysis || analysis.error) {
      return res.status(500).json({
        success: false,
        error: analysis?.error || '分析失敗'
      });
    }

    // 2. 生成優化建議
    const suggestions = await reportGenerator.generateSuggestions(analysis);
    
    // 3. 格式化報告
    const report = reportGenerator.formatReport(analysis, suggestions);
    
    // 4. 發送到 LINE
    if (process.env.ADMIN_USER_ID) {
      await client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: report
      });
    }
    
    res.json({
      success: true,
      message: '週報已生成並發送到 LINE',
      preview: report.substring(0, 200) + '...'
    });
    
  } catch (error) {
    console.error('手動週報生成失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// 🔥 手動觸發 API（結束）🔥
// ====== 其餘 API 保持不變（以下全部保留） ======
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  let orders = status ? orderManager.getOrdersByStatus(status) : orderManager.getAllOrders();
  const ordersWithStatus = orders.map(order => ({
    ...order,
    isExpired: orderManager.isExpired(order.orderId),
    remainingTime: Math.max(0, order.expiryTime - Date.now()),
    remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
  }));
  res.json({
    success: true,
    total: ordersWithStatus.length,
    orders: ordersWithStatus,
    statistics: orderManager.getStatistics()
  });
});

app.get('/api/order/:orderId', (req, res) => {
  const order = orderManager.getOrder(req.params.orderId);
  if (order) {
    res.json({
      success: true,
      order: {
        ...order,
        isExpired: orderManager.isExpired(order.orderId),
        remainingTime: Math.max(0, order.expiryTime - Date.now()),
        remainingHours: Math.floor(Math.max(0, order.expiryTime - Date.now()) / (1000 * 60 * 60))
      }
    });
  } else {
    res.status(404).json({ success: false, error: '找不到此訂單' });
  }
});

app.post('/api/order/:orderId/renew', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.renewOrder(orderId);
  if (!order) return res.status(404).json({ success: false, error: '找不到此訂單' });

  try {
    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    let ecpayShort = ecpayPersistentUrl;
    let linepayShort = linepayPersistentUrl;

    try {
      const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
      const t2 = await r2.text();
      if (t2 && t2.startsWith('http')) ecpayShort = t2;
    } catch { logger.logToFile(`綠界短網址失敗，使用原網址`); }

    try {
      const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
      const t1 = await r1.text();
      if (t1 && t1.startsWith('http')) linepayShort = t1;
    } catch { logger.logToFile(`LINE Pay 短網址失敗,使用原網址`); }

    await client.pushMessage(order.userId, {
      type: 'text',
      text:
        `付款連結已重新生成（持久網址）\n\n` +
        `訂單編號: ${orderId}\n客戶姓名: ${order.userName}\n金額: NT$ ${order.amount.toLocaleString()}\n\n` +
        `— 請選擇付款方式 —\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結可重複點擊，隨時都可以付款。\n` +
        `付款後系統會自動通知我們`
    });

    orderManager.markReminderSent(orderId);
    logger.logToFile(`單筆續約重發（綠界+LINE Pay 持久網址）：${orderId}`);

    return res.json({
      success: true,
      message: '訂單已續約並重新發送付款連結（持久網址：綠界 + LINE Pay）',
      order,
      links: { ecpay: ecpayShort, linepay: linepayShort }
    });
  } catch (error) {
    logger.logError('續約訂單失敗', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/order/:orderId', (req, res) => {
  const deleted = orderManager.deleteOrder(req.params.orderId);
  if (deleted) res.json({ success: true, message: '訂單已刪除' });
  else res.status(404).json({ success: false, error: '找不到此訂單' });
});

app.post('/api/orders/send-reminders', async (req, res) => {
  const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
  if (ordersNeedingReminder.length === 0) {
    return res.json({ success: true, message: '目前沒有需要提醒的訂單', sent: 0 });
  }

  let sent = 0;
  const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
  const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

  for (const order of ordersNeedingReminder) {
    try {
      const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${order.orderId}`;
      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${order.orderId}`;

      let linepayShort = linepayPersistentUrl;
      let ecpayShort = ecpayPersistentUrl;

      try {
        const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
        const t1 = await r1.text();
        if (t1 && t1.startsWith('http')) linepayShort = t1;
      } catch {}

      try {
        const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const t2 = await r2.text();
        if (t2 && t2.startsWith('http')) ecpayShort = t2;
      } catch {}

      const reminderText =
        `溫馨付款提醒\n\n` +
        `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
        `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
        `【信用卡／綠界】\n${ecpayShort}\n\n` +
        `【LINE Pay】\n${linepayShort}\n\n` +
        `備註：以上連結有效期間內可重複點擊付款。\n` +
        `若已完成付款，請忽略此訊息。感謝您的支持 💙`;

      await client.pushMessage(order.userId, { type: 'text', text: reminderText });

      sent++;
      orderManager.markReminderSent(order.orderId);
      logger.logToFile(`已發送付款提醒：${order.orderId} (第 ${order.reminderCount} 次)`);
    } catch (error) {
      logger.logError(`發送提醒失敗: ${order.orderId}`, error);
    }
  }

  res.json({ success: true, message: `已發送 ${sent} 筆付款提醒`, sent: sent });
});

app.get('/api/orders/statistics', (req, res) => {
  res.json({ success: true, statistics: orderManager.getStatistics() });
});

app.get('/api/customer-numbers', (req, res) => {
  try {
    const customers = orderManager.getAllCustomerNumbers();
    res.json({ success: true, total: customers.length, customers });
  } catch (error) {
    console.error('API /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/customer-numbers', (req, res) => {
  try {
    const { number, name, userId } = req.body;
    if (!number || !name || !userId) {
      return res.status(400).json({ success: false, error: '請填寫所有欄位' });
    }
    const customer = orderManager.saveCustomerNumber(number, name, userId);
    res.json({ success: true, message: '客戶編號已儲存', customer });
  } catch (error) {
    console.error('API POST /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/customer-numbers/:number', (req, res) => {
  try {
    const deleted = orderManager.deleteCustomerNumber(req.params.number);
    if (deleted) {
      res.json({ success: true, message: '客戶編號已刪除' });
    } else {
      res.status(404).json({ success: false, error: '找不到此客戶編號' });
    }
  } catch (error) {
    console.error('API DELETE /api/customer-numbers 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/customer-numbers/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: '請提供搜尋關鍵字' });
    const results = orderManager.searchCustomerNumber(q);
    res.json({ success: true, total: results.length, customers: results });
  } catch (error) {
    console.error('API /api/customer-numbers/search 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/templates', (req, res) => {
  try {
    const templates = orderManager.getAllTemplates();
    res.json({ success: true, total: templates.length, templates });
  } catch (error) {
    console.error('API /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📊 營業報表 API（從 Google Sheets 讀取）
app.get('/api/revenue/report', async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) {
      return res.json({ success: false, error: '請提供月份' });
    }

    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    
    if (!googleAuth.isAuthorized()) {
      return res.json({ success: false, error: '尚未授權 Google Sheets' });
    }

    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    if (!spreadsheetId) {
      return res.json({ success: false, error: '未設定 GOOGLE_SHEETS_ID_CUSTOMER' });
    }

    // 🔥 改用 Sheet1 或直接用 gid 對應的工作表標題
    // 先嘗試讀取試算表的所有工作表名稱
    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties'
    });

    // 找到 gid=756780563 的工作表
    const targetSheet = sheetInfo.data.sheets.find(
      sheet => sheet.properties.sheetId === 756780563
    );

    if (!targetSheet) {
      return res.json({ success: false, error: '找不到營業紀錄工作表' });
    }

    const sheetName = targetSheet.properties.title;
    console.log(`✅ 找到工作表: ${sheetName}`);

    // 讀取資料（使用正確的工作表名稱）
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:I`,  // 用單引號包住工作表名稱
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
      return res.json({ 
        success: true, 
        monthlyTotal: 0, 
        dailyAverage: 0, 
        totalOrders: 0, 
        dailyRevenue: [] 
      });
    }

    // 過濾出指定月份的資料
    const [targetYear, targetMonth] = month.split('-');
    const dailyRevenue = {};
    let monthlyTotal = 0;
    let totalOrders = 0;

    rows.slice(1).forEach(row => {
      const dateStr = row[0];
      const amountStr = row[8];
      
      if (!dateStr || !amountStr) return;

      const dateParts = dateStr.toString().replace(/\//g, '-').split('-');
      if (dateParts.length < 3) return;

      const year = dateParts[0];
      const month = dateParts[1].padStart(2, '0');
      const day = dateParts[2].padStart(2, '0');

      if (year !== targetYear || month !== targetMonth) return;

      const dayKey = `${year}-${month}-${day}`;
      
      let amount = 0;
      if (typeof amountStr === 'number') {
        amount = amountStr;
      } else {
        const cleaned = String(amountStr).replace(/[^0-9]/g, '');
        amount = parseInt(cleaned, 10) || 0;
      }

      if (!dailyRevenue[dayKey]) {
        dailyRevenue[dayKey] = { date: dayKey, amount: 0, orders: 0 };
      }

      dailyRevenue[dayKey].amount += amount;
      dailyRevenue[dayKey].orders += 1;
      monthlyTotal += amount;
      totalOrders += 1;
    });

    const dailyArray = Object.values(dailyRevenue).sort((a, b) => a.date.localeCompare(b.date));
   // 計算分母：當月已過天數，扣除週六（固定公休）
const [y, m] = [parseInt(targetYear), parseInt(targetMonth)];
const today = new Date();
const isCurrentMonth = (today.getFullYear() === y && today.getMonth() + 1 === m);
const lastDay = isCurrentMonth ? today.getDate() : new Date(y, m, 0).getDate();

let workDays = 0;
for (let d = 1; d <= lastDay; d++) {
  const dow = new Date(y, m - 1, d).getDay();
  if (dow !== 6) workDays++; // 扣除週六(6)
}

const dailyAverage = workDays > 0 ? Math.round(monthlyTotal / workDays) : 0;

    res.json({
      success: true,
      monthlyTotal,
      dailyAverage,
      totalOrders,
      dailyRevenue: dailyArray
    });

  } catch (error) {
    console.error('營業報表錯誤:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/templates', (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    orderManager.addTemplate(content.trim());
    res.json({ success: true, message: '模板已新增' });
  } catch (error) {
    console.error('API POST /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    const success = orderManager.updateTemplate(index, content.trim());
    if (success) res.json({ success: true, message: '模板已更新' });
    else res.status(404).json({ success: false, error: '找不到此模板' });
  } catch (error) {
    console.error('API PUT /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const success = orderManager.deleteTemplate(index);
    if (success) res.json({ success: true, message: '模板已刪除' });
    else res.status(404).json({ success: false, error: '找不到此模板' });
  } catch (error) {
    console.error('API DELETE /api/templates 錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== 純文字通知模板管理 ======
const NOTIFY_TEMPLATES_FILE = '/data/notify-templates.json';

function loadNotifyTemplates() {
  try {
    if (fs.existsSync(NOTIFY_TEMPLATES_FILE)) {
      const data = fs.readFileSync(NOTIFY_TEMPLATES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.logError('載入通知模板失敗', error);
  }
  return [];
}

function saveNotifyTemplatesFile(templates) {
  try {
    fs.writeFileSync(NOTIFY_TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger.logError('儲存通知模板失敗', error);
    return false;
  }
}

app.get('/api/notify-templates', (req, res) => {
  try {
    const templates = loadNotifyTemplates();
    res.json({ success: true, templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/notify-templates', (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    
    const templates = loadNotifyTemplates();
    templates.push(content.trim());
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已儲存' });
    } else {
      res.status(500).json({ success: false, error: '儲存失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/notify-templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: '模板內容不能為空' });
    }
    
    const templates = loadNotifyTemplates();
    if (index < 0 || index >= templates.length) {
      return res.status(404).json({ success: false, error: '找不到此模板' });
    }
    
    templates[index] = content.trim();
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已更新' });
    } else {
      res.status(500).json({ success: false, error: '更新失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/notify-templates/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const templates = loadNotifyTemplates();
    
    if (index < 0 || index >= templates.length) {
      return res.status(404).json({ success: false, error: '找不到此模板' });
    }
    
    templates.splice(index, 1);
    
    if (saveNotifyTemplatesFile(templates)) {
      res.json({ success: true, message: '模板已刪除' });
    } else {
      res.status(500).json({ success: false, error: '刪除失敗' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const deliveryService = require('./services/deliveryService');
deliveryService.setLineClient(client);

// ========== 📦 外送排程 → 轉取件追蹤 ==========
app.post('/api/delivery/convert-to-pickup', async (req, res) => {
  try {
    const { id, customerNumber, customerName } = req.body;
    if (!id || !customerNumber || !customerName) {
      return res.json({ success: false, error: '缺少必要參數' });
    }

    // 1. 客戶編號轉換：K0000625 → 625
    const cleanNo = String(customerNumber).replace(/\D/g, '').replace(/^0+/, '') || customerNumber;
    console.log(`[轉取件] 編號轉換: ${customerNumber} → ${cleanNo}`);

    // 2. 用客戶姓名比對找 userId
    let userId = null;

    // 方法 A: 從 customerDB 找
    try {
      const allCustomers = customerDB.getAllCustomers();
      const found = allCustomers.find(c => {
        const cName = (c.displayName || c.name || '').replace(/\s/g, '');
        const inputName = customerName.replace(/\s/g, '');
        return cName && inputName && (cName.includes(inputName) || inputName.includes(cName));
      });
      if (found) userId = found.userId;
    } catch (e) { console.log('customerDB 比對失敗:', e.message); }

    // 方法 B: 從 orderManager 的客戶編號找
    if (!userId) {
      try {
        const allCustNums = orderManager.getAllCustomerNumbers();
        const found2 = allCustNums.find(c => {
          const cNo = String(c.number).replace(/\D/g, '').replace(/^0+/, '');
          return cNo === cleanNo;
        });
        if (found2) userId = found2.userId;
      } catch (e) { console.log('orderManager 比對失敗:', e.message); }
    }

    // 方法 C: 從 /data/users.json 找
    if (!userId) {
      try {
        const USERS_FILE = path.join('/data', 'users.json');
        if (fs.existsSync(USERS_FILE)) {
          const userList = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
          const found3 = userList.find(u => {
            const uName = (u.name || '').replace(/\s/g, '');
            const inputName = customerName.replace(/\s/g, '');
            return uName && inputName && (uName.includes(inputName) || inputName.includes(uName));
          });
          if (found3) userId = found3.userId;
        }
      } catch (e) { console.log('users.json 比對失敗:', e.message); }
    }

    if (!userId) {
      return res.json({
        success: false,
        error: `找不到客戶「${customerName}」(編號:${cleanNo}) 的 LINE User ID，請至取件追蹤頁面手動新增`
      });
    }

    console.log(`[轉取件] 找到 userId: ${userId}`);

    // 3. 寫入 pickup-tracking.json（靜默加入，不發 LINE 通知）
    const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
    const PICKUP_FILE = path.join(baseDir, 'pickup-tracking.json');

    let pickupData = { orders: [] };
    if (fs.existsSync(PICKUP_FILE)) {
      pickupData = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
    }

    // 檢查是否已存在
    const alreadyExists = pickupData.orders.some(o => {
      const oNo = String(o.customerNumber).replace(/\D/g, '').replace(/^0+/, '');
      return oNo === cleanNo;
    });

    if (alreadyExists) {
      console.log(`[轉取件] 編號 ${cleanNo} 已在取件追蹤中`);
    } else {
      const now = new Date();
      const reminderAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      reminderAt.setHours(11, 0, 0, 0);

      pickupData.orders.push({
        customerNumber: cleanNo,
        customerName: customerName,
        userId: userId,
        createdAt: now.toISOString(),
        nextReminderAt: reminderAt.toISOString(),
        reminderCount: 0,
        pickedUp: false
      });

      fs.writeFileSync(PICKUP_FILE, JSON.stringify(pickupData, null, 2), 'utf8');
      console.log(`✅ [轉取件] 已將 ${customerName}(${cleanNo}) 加入取件追蹤`);
    }

    // 4. 從 delivery.json 刪除這筆
    const DELIVERY_FILE = path.join(__dirname, 'data', 'delivery.json');
    if (fs.existsSync(DELIVERY_FILE)) {
      const deliveryData = JSON.parse(fs.readFileSync(DELIVERY_FILE, 'utf8'));
      const originalLen = deliveryData.orders.length;
      deliveryData.orders = deliveryData.orders.filter(o => o.id !== id);
      fs.writeFileSync(DELIVERY_FILE, JSON.stringify(deliveryData, null, 2), 'utf8');
      const deleted = originalLen - deliveryData.orders.length;
      console.log(`✅ [轉取件] 已從外送排程刪除 ${deleted} 筆`);
    }

    res.json({
      success: true,
      message: `✅ 已將 ${customerName}(#${cleanNo}) 轉入取件追蹤，7天後開始提醒`,
      userId: userId
    });

  } catch (error) {
    console.error('❌ 轉取件追蹤失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ========== 📦 轉取件追蹤結束 ==========

// ========================================
// ========================================
// API 1: 金額=0的簡單通知
// ========================================
app.post('/api/delivery/mark-signed-simple', async (req, res) => {
  try {
    const { id, customerNumber, customerName } = req.body;

    if (!id || !customerNumber || !customerName) {
      return res.json({
        success: false,
        error: '缺少必要參數'
      });
    }

    // ✅ 更新外送紀錄為已簽收
    const deliveryRoutes = require('./routes/deliveryRoutes');
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    const order = data.orders.find(o => o.id === id);
    
    if (order) {
      order.signed = true;
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    }

    await deliveryService.markSignedSimple(id, customerNumber, customerName);


    // 🔥🔥🔥 自動刪除取件追蹤記錄（開始）🔥🔥🔥
    try {
      const PICKUP_FILE = path.join(__dirname, 'data', 'pickup.json');
      if (fs.existsSync(PICKUP_FILE)) {
        const pickupData = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
        const originalLength = pickupData.orders ? pickupData.orders.length : 0;
        
        // 刪除符合客戶編號的取件追蹤
        if (pickupData.orders) {
          pickupData.orders = pickupData.orders.filter(o => o.customerNumber !== customerNumber);
          fs.writeFileSync(PICKUP_FILE, JSON.stringify(pickupData, null, 2), 'utf8');
          
          const deletedCount = originalLength - pickupData.orders.length;
          if (deletedCount > 0) {
            console.log(`✅ 已自動刪除 ${deletedCount} 筆取件追蹤記錄（客戶編號：${customerNumber}）`);
          }
        }
      }
    } catch (pickupErr) {
      console.error('⚠️ 刪除取件追蹤失敗（不影響簽收）:', pickupErr.message);
    }
    // 🔥🔥🔥 自動刪除取件追蹤記錄（結束）🔥🔥🔥

    res.json({ success: true });


  } catch (error) {
    console.error('API Error:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// API 2: 金額>0發送支付連結（修復訊息不穩定問題）
// ========================================
app.post('/api/delivery/mark-signed-with-payment', async (req, res) => {
  try {
    const { id, customerNumber, customerName, amount } = req.body;

    if (!id || !customerNumber || !customerName || !amount) {
      return res.json({
        success: false,
        error: '缺少必要參數'
      });
    }

    console.log(`🔔 外送簽收付款流程開始: #${customerNumber} - ${customerName} - NT$${amount}`);

    // ✅ 1. 更新外送紀錄為已簽收
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    const order = data.orders.find(o => o.id === id);
    
    if (order) {
      order.signed = true;
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
      console.log(`✅ 外送紀錄已標記簽收: ${id}`);
    }

    // ✅ 2. 呼叫 deliveryService 建立訂單
    const result = await deliveryService.markSignedWithPayment(
      id,
      customerNumber,
      customerName,
      amount
    );
    
    console.log(`✅ 訂單已建立: ${result.orderId}`);

    // 🔥🔥🔥 3. 自動刪除取件追蹤記錄 🔥🔥🔥
    try {
      const PICKUP_FILE = path.join(__dirname, 'data', 'pickup.json');
      if (fs.existsSync(PICKUP_FILE)) {
        const pickupData = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
        const originalLength = pickupData.orders ? pickupData.orders.length : 0;
        
        if (pickupData.orders) {
          pickupData.orders = pickupData.orders.filter(o => o.customerNumber !== customerNumber);
          fs.writeFileSync(PICKUP_FILE, JSON.stringify(pickupData, null, 2), 'utf8');
          
          const deletedCount = originalLength - pickupData.orders.length;
          if (deletedCount > 0) {
            console.log(`✅ 已自動刪除 ${deletedCount} 筆取件追蹤記錄（客戶編號：${customerNumber}）`);
          }
        }
      }
    } catch (pickupErr) {
      console.error('⚠️ 刪除取件追蹤失敗（不影響簽收）:', pickupErr.message);
    }

    // 🔥🔥🔥 4. 檢查並重新發送付款連結（修復訊息不穩定問題）🔥🔥🔥
    console.log(`🔍 開始檢查訂單狀態...`);
    
    await new Promise(r => setTimeout(r, 2000)); // 等待 2 秒確保訂單建立完成
    
    const createdOrder = orderManager.getOrder(result.orderId);
    
    if (!createdOrder) {
      console.error(`❌ 訂單建立失敗，找不到訂單: ${result.orderId}`);
      return res.json({
        success: false,
        error: '訂單建立失敗'
      });
    }

    console.log(`✅ 訂單確認存在: ${result.orderId}`);

    // 🔥 重新發送付款連結（確保訊息送達）
    try {
      const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
      const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';
      const linepayUrl = `${baseURL}/payment/linepay/pay/${result.orderId}`;
      const ecpayUrl = `${baseURL}/payment/ecpay/pay/${result.orderId}`;

      let linepayShort = linepayUrl;
      let ecpayShort = ecpayUrl;

      // 生成短網址（加入重試）
      for (let retry = 0; retry < 3; retry++) {
        try {
          const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayUrl)}`);
          const t1 = await r1.text();
          if (t1 && t1.startsWith('http')) {
            linepayShort = t1;
            break;
          }
        } catch (e) {
          if (retry === 2) console.log('⚠️ LINE Pay 短網址失敗，使用原網址');
        }
      }

      for (let retry = 0; retry < 3; retry++) {
        try {
          const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayUrl)}`);
          const t2 = await r2.text();
          if (t2 && t2.startsWith('http')) {
            ecpayShort = t2;
            break;
          }
        } catch (e) {
          if (retry === 2) console.log('⚠️ 綠界短網址失敗，使用原網址');
        }
      }

      const message = `✅ 您的衣物已送達！\n\n` +
        `感謝 ${customerName} 的支持\n` +
        `金額：NT$ ${amount.toLocaleString()}\n\n` +
        `請選擇付款方式：\n\n` +
        `【信用卡付款】\n💙 ${ecpayShort}\n\n` +
        `【LINE Pay】\n💙 ${linepayShort}\n\n` +
        `✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;

      // 🔥 加入重試機制（最多 3 次）
      let sent = false;
      for (let retry = 0; retry < 3; retry++) {
        try {
          await client.pushMessage(createdOrder.userId, {
            type: 'text',
            text: message
          });
          sent = true;
          console.log(`✅ 付款連結已發送給客人 (第 ${retry + 1} 次嘗試成功)`);
          break;
        } catch (sendErr) {
          console.error(`❌ 發送失敗 (第 ${retry + 1} 次):`, sendErr.message);
          if (retry < 2) {
            await new Promise(r => setTimeout(r, 1000)); // 等待 1 秒後重試
          }
        }
      }

      if (!sent) {
        console.error(`❌ 付款連結發送失敗（已重試 3 次）`);
      }

    } catch (messageErr) {
      console.error('❌ 發送付款連結失敗:', messageErr.message);
    }

    res.json({
      success: true,
      orderId: result.orderId
    });

  } catch (error) {
    console.error('❌ 外送簽收付款流程錯誤:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ====== 發送純文字通知 ======
app.post('/send-notification', async (req, res) => {
  const { userId, userName, message } = req.body;
  
  logger.logToFile(`收到純文字通知請求: userId=${userId}, userName=${userName}`);

  if (!userId || !userName || !message) {
    logger.logToFile(`參數驗證失敗`);
    return res.status(400).json({ 
      success: false, 
      error: '缺少必要參數', 
      required: ['userId', 'userName', 'message'] 
    });
  }

  try {
    await client.pushMessage(userId, { 
      type: 'text', 
      text: message 
    });
    
    logger.logToFile(`已發送純文字通知給: ${userName} (${userId})`);

    res.json({
      success: true,
      message: '通知已發送',
      data: {
        userId,
        userName,
        messageLength: message.length
      }
    });
  } catch (err) {
    logger.logError('發送純文字通知失敗', err);
    res.status(500).json({ 
      success: false, 
      error: '發送失敗', 
      details: err.message 
    });
  }
});
// ====== 修改後的發送付款 API (整合 #指定單號 + 自動存客戶資料) ======
app.post('/send-payment', async (req, res) => {
  const { userId, userName, amount, paymentType, customMessage } = req.body;
  
  // 1. 記錄請求
  logger.logToFile(`收到付款請求: userId=${userId}, userName=${userName}, amount=${amount}, type=${paymentType}`);

  if (!userId || !userName || !amount) {
    logger.logToFile(`參數驗證失敗`);
    return res.status(400).json({ error: '缺少必要參數', required: ['userId', 'userName', 'amount'] });
  }

  const numAmount = parseInt(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: '金額必須是正整數' });
  }

  // 🔥🔥🔥 【魔術代碼功能】 🔥🔥🔥
  // 檢查訊息內容是否有 #單號
  let manualOrderId = null;
  if (customMessage && customMessage.includes('#')) {
      const match = customMessage.match(/#([a-zA-Z0-9]+)/);
      if (match) {
          manualOrderId = match[1]; // 抓出 # 後面的號碼
          logger.logToFile(`🎯 偵測到指定單號: ${manualOrderId}`);
      }
  }
  // 🔥🔥🔥 結束 🔥🔥🔥

  // ⭐⭐⭐ 自動儲存客戶資料 (原本的功能) ⭐⭐⭐
  try {
    const DATA_DIR = '/data';
    const USERS_FILE = path.join(DATA_DIR, 'users.json');

    // 確保目錄存在
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      logger.logToFile(`✅ 已建立 /data 目錄`);
    }

    // 確保檔案存在
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
      logger.logToFile(`✅ 已建立 users.json 檔案`);
    }

    // 讀取現有客戶資料
    let userList = [];
    try {
      const fileContent = fs.readFileSync(USERS_FILE, 'utf8');
      userList = JSON.parse(fileContent);
    } catch (e) {
      logger.logToFile(`⚠️ 讀取 users.json 失敗，使用空陣列`);
      userList = [];
    }

    // 檢查客戶是否已存在
    const existIndex = userList.findIndex(u => u.userId === userId);
    const timestamp = new Date().toISOString();

    if (existIndex >= 0) {
      // 更新現有客戶
      userList[existIndex] = {
        userId: userId,
        name: userName,
        lastUpdate: timestamp,
        createdAt: userList[existIndex].createdAt || timestamp
      };
      logger.logToFile(`♻️ 更新客戶資料: ${userName} (${userId})`);
    } else {
      // 新增客戶
      userList.push({
        userId: userId,
        name: userName,
        createdAt: timestamp,
        lastUpdate: timestamp
      });
      logger.logToFile(`➕ 新增客戶資料: ${userName} (${userId})`);
    }

    // 寫回檔案
    fs.writeFileSync(USERS_FILE, JSON.stringify(userList, null, 2), 'utf8');
    logger.logToFile(`💾 已將客戶資料寫入 /data/users.json (總共 ${userList.length} 筆)`);

    // 同時也存進 customerDB（雙重備份）
    try {
      await customerDB.saveCustomer(userId, userName);
    } catch (e) {
      logger.logToFile(`⚠️ customerDB 同步失敗: ${e.message}`);
    }
  } catch (saveError) {
    // ⚠️ 重要：儲存客戶資料失敗不應影響付款流程，只記錄錯誤
    logger.logError('儲存客戶資料失敗（不影響付款流程）', saveError);
  }
  // ⭐⭐⭐ 客戶資料儲存結束 ⭐⭐⭐

  // ====== 開始處理付款連結 ======
  try {
    const type = paymentType || 'both';

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    let finalMessage = '';
    let ecpayLink = '';
    let linepayLink = '';
    let ecpayOrderId = '';
    let linePayOrderId = '';

    // 🔥 決定單號：如果有抓到 #單號 就用它，沒有就自動產生亂碼 🔥
    const commonOrderId = manualOrderId || `ORDER${Date.now()}`;

    // --- 1. 綠界 (ECPay) ---
    if (type === 'ecpay' || type === 'both') {
      // 若有指定單號，就用指定的；否則產生 EC 開頭亂碼
      ecpayOrderId = manualOrderId ? manualOrderId : `EC${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount });
      logger.logToFile(`建立綠界訂單: ${ecpayOrderId}`);

      const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = ecpayPersistentUrl;

      try {
        const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
        const result = await response.text();
        if (result && result.startsWith('http')) ecpayLink = result;
      } catch {
        logger.logToFile(`短網址生成失敗,使用原網址`);
      }
    }

    // --- 2. LINE Pay ---
    if (type === 'linepay' || type === 'both') {
      // 🔥 若有指定單號，就強制讓 Line Pay 使用這個單號 (讓 Python 機器人認得)
      linePayOrderId = manualOrderId ? manualOrderId : `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

      // 建立交易
      // ⚠️ 關鍵：這裡傳進去的 linePayOrderId 就是將來 Python 會收到的 ID
      const linePayResult = await createLinePayPayment(userId, userName, numAmount, linePayOrderId);

      if (linePayResult.success) {
        orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount });

        const paymentUrl = linePayResult.paymentUrlApp || linePayResult.paymentUrlWeb || linePayResult.paymentUrl;
        orderManager.updatePaymentInfo(linePayOrderId, {
          linepayTransactionId: linePayResult.transactionId,
          linepayPaymentUrl: paymentUrl,
          lastLinePayRequestAt: Date.now()
        });

        const persistentUrl = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
        linepayLink = persistentUrl; 
        logger.logToFile(`建立 LINE Pay 訂單(PERSISTENT): ${linePayOrderId}`);
      }
    }

    // --- 3. 組合回傳訊息 ---
    const userMsg = customMessage || '';
    
    // 如果有指定單號，在訊息裡偷標註一下，方便你確認
    const orderNote = manualOrderId ? `(單號:${manualOrderId})` : '';

    if (type === 'both' && ecpayLink && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n金額:NT$ ${numAmount.toLocaleString()}\n\n請選擇付款方式:\n\n【信用卡付款】\n💙 ${ecpayLink}\n\n【LINE Pay】\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'ecpay' && ecpayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n付款方式:信用卡\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${ecpayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else if (type === 'linepay' && linepayLink) {
      finalMessage = userMsg
        ? `${userMsg}\n\n💙 付款連結 ${orderNote}:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`
        : `💙 您好,${userName}\n\n您的專屬付款連結已生成 ${orderNote}\n付款方式:LINE Pay\n金額:NT$ ${numAmount.toLocaleString()}\n\n請點擊以下連結完成付款:\n💙 ${linepayLink}\n\n✅ 付款後系統會自動通知我們\n感謝您的支持 💙`;
    } else {
      return res.status(500).json({ error: '付款連結生成失敗' });
    }

    await client.pushMessage(userId, { type: 'text', text: finalMessage });
    logger.logToFile(`已發送付款連結: ${userName} - ${numAmount}元 (${type})`);

    res.json({
      success: true,
      message: '付款連結已發送',
      data: {
        userId,
        userName,
        amount: numAmount,
        paymentType: type,
        ecpayLink: ecpayLink || null,
        linepayLink: linepayLink || null,
        ecpayOrderId: ecpayOrderId || null,
        linePayOrderId: linePayOrderId || null,
        customMessage: userMsg
      }
    });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '發送失敗', details: err.message });
  }
});

app.get('/payment', (req, res) => {
  res.sendFile('payment.html', { root: './public' });
});

app.get('/payment/status/:orderId', async (req, res) => {
  res.json({ message: '付款狀態查詢功能(待實作)', orderId: req.params.orderId });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/liff/payment', (req, res) => {
  res.sendFile('liff-payment.html', { root: './public' });
});

// 讓 LIFF 永遠拿到可用的 LINE Pay 連結：舊的>15分鐘就重建
app.get('/api/linepay/url/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'];
  const ref = req.headers['referer'] || 'no-ref';
  logger.logToFile(`[LINEPAY][LIFF_GET_URL_HIT] ip=${ip} ua="${ua}" ref="${ref}" method=${req.method} path=${req.path} extra=${JSON.stringify({orderId})}`);

  if (!order) {
    return res.json({ success: false, error: '找不到訂單' });
  }
  if (order.status === 'paid') {
    return res.json({ success: false, error: '訂單已付款' });
  }

  try {
    const now = Date.now();
    const last = order.lastLinePayRequestAt || 0;
    const elapsed = now - last;
    const EXPIRE_MS = 15 * 60 * 1000; // 15 分鐘（僅用於重建檢查，不影響你 168 小時訂單有效期）

    // 若已有連結且仍在 15 分鐘內 → 直接用
    if (order.linepayPaymentUrl && elapsed < EXPIRE_MS) {
      logger.logToFile(`LIFF: 重用既有連結 ${orderId}（${Math.floor(elapsed / 1000)} 秒內）`);
      return res.json({ success: true, paymentUrl: order.linepayPaymentUrl });
    }

    // 沒有連結或已逾 15 分鐘 → 重建
    logger.logToFile(`LIFF: 重新建立 LINE Pay 連結 ${orderId}（elapsed=${elapsed}ms）`);
    const lp = await createLinePayPayment(order.userId, order.userName, order.amount, orderId);
    if (!lp?.success) {
      return res.json({ success: false, error: lp?.error || '建立 LINE Pay 交易失敗' });
    }

   const urlApp = lp.paymentUrlApp || null;
const urlWeb = lp.paymentUrlWeb || null;
const urlAny = urlApp || urlWeb || lp.paymentUrl;


orderManager.updatePaymentInfo(orderId, {
  linepayTransactionId: lp.transactionId,
  linepayPaymentUrl: urlAny,      // 通用網址
  linepayPaymentUrlApp: urlApp,   // 儲存 app 連結
  linepayPaymentUrlWeb: urlWeb,   // 儲存 web 連結
  lastLinePayRequestAt: now
});

const ua = String(req.headers['user-agent'] || '');
const preferApp = /Line\/|LineApp/i.test(ua); // 在 LINE App 內用 app 連結
const chosenUrl = preferApp ? (urlApp || urlAny) : (urlWeb || urlAny);

logger.logToFile(`LIFF: 交易建立 ${lp.transactionId}`);
return res.json({ success: true, paymentUrl: chosenUrl });
} catch (error) {
  logger.logError('LIFF: 取得 LINE Pay URL 失敗', error);
  return res.json({ success: false, error: '系統錯誤' });
}
});


// ==========================================
// 🚀 新增功能：洗衣店地端同步 API
// ==========================================

// 1. 建立一個全域變數，用來暫存「已付款但尚未同步」的訂單
// 注意：如果 Railway 重啟，這個變數會清空。如果要永久保存，需要存到資料庫。
// 但對於即時同步來說，用記憶體陣列 (Array) 通常就夠用了。
global.pendingSyncOrders = [];

// 2. API: 讓店裡電腦查詢「有哪些新付款？」
app.get('/api/get-pending-payments', (req, res) => {
    res.json(global.pendingSyncOrders);
});

// 3. API: 店裡電腦同步完成後，呼叫這個把它刪掉
app.post('/api/mark-synced', (req, res) => {
    const { orderId } = req.body;
    console.log(`[Sync] 店裡電腦已同步訂單: ${orderId}`);
    
    // 從清單中移除這筆訂單
    global.pendingSyncOrders = global.pendingSyncOrders.filter(o => o.orderId !== orderId);
    
    res.json({ success: true });
});

// ==========================================
// 🚚 外送行程接收接口 (給 Python 機器人用的)
// ==========================================
// ==========================================
// 🚚 外送行程接收接口 (修正版：預設為未簽收 Pending)
// ==========================================
app.post('/api/create-delivery-task', async (req, res) => {
    try {
        const { orderNo, customerNo, name, userId, mobile, status } = req.body;
        
        console.log(`[API] 收到 POS 完工通知: ${name} (${orderNo})`);

        const fs = require('fs');
        const path = require('path');
        const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
        
        let deliveryData = { orders: [] };
        if (fs.existsSync(FILE_PATH)) {
            deliveryData = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        }

        const exists = deliveryData.orders.some(o => o.orderNo === orderNo);
        
        if (!exists) {
            deliveryData.orders.push({
                id: `DELIVERY_${Date.now()}`,
                orderNo,
                customerNumber: customerNo,
                customerName: name,
                mobile,
                // 🔥 這裡改了！改成 Pending 代表「待處理/未簽收」
                status: 'Pending', 
                createdAt: new Date().toISOString(),
                // 🔥 這裡確認是 false
                signed: false 
            });
            fs.writeFileSync(FILE_PATH, JSON.stringify(deliveryData, null, 2), 'utf8');
            console.log(`✅ 已加入外送行程 (未簽收): ${orderNo}`);
        } else {
            console.log(`⚠️ 訂單已存在，略過: ${orderNo}`);
        }

        res.status(200).json({ success: true, message: "已接收並加入行程" });

    } catch (error) {
        console.error("外送排程錯誤:", error);
        res.status(500).send("Server Error");
    }
});

// ========================================
// 🔧 外送排程緊急修復 API
// ========================================

// 重建外送資料檔案
app.get('/api/delivery/reset', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    // 備份舊檔案
    if (fs.existsSync(FILE_PATH)) {
      const backupPath = FILE_PATH.replace('.json', '_backup_' + Date.now() + '.json');
      fs.copyFileSync(FILE_PATH, backupPath);
      console.log('✅ 已備份舊檔案:', backupPath);
    }
    
    // 建立全新檔案
    const newData = { orders: [] };
    fs.writeFileSync(FILE_PATH, JSON.stringify(newData, null, 2), 'utf8');
    
    res.json({
      success: true,
      message: '✅ 外送資料檔案已重建（舊資料已備份）'
    });
    
  } catch (error) {
    console.error('重建失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 檢查外送資料檔案狀態
app.get('/api/delivery/check', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'delivery.json');
    
    if (!fs.existsSync(FILE_PATH)) {
      return res.json({
        success: false,
        exists: false,
        message: '檔案不存在'
      });
    }
    
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    const validCount = (data.orders || []).filter(o => o && o.id).length;
    const totalCount = (data.orders || []).length;
    
    res.json({
      success: true,
      exists: true,
      totalOrders: totalCount,
      validOrders: validCount,
      invalidOrders: totalCount - validCount,
      data: data
    });
    
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});


// ========================================
// 🏠 收件排程 API
// ========================================

// 📥 自動新增收件排程
app.post('/api/pickup-schedule/auto-add', async (req, res) => {
  const { userId, userName, message, source, customerNumber } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    // 確保資料夾存在
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    
    // 載入現有資料
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    // 檢查今天是否已經記錄過
    const today = new Date().toISOString().split('T')[0];
    const existing = data.schedules.find(s => 
      s.userId === userId && 
      s.pickupDate === today && 
      s.status === 'pending'
    );
    
    if (existing) {
      return res.json({ 
        success: true, 
        message: '今天已記錄此客戶',
        alreadyExists: true 
      });
    }
    
    // 建立新記錄
    const schedule = {
      id: 'PICKUP' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase(),
      customerNumber: customerNumber || '未登記',
      customerName: userName,
      userId: userId,
      pickupDate: today,
      source: source, // 'customer' 或 'ai'
      originalMessage: message,
      note: '',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    data.schedules.push(schedule);
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ 
      success: true, 
      message: '✅ 已記錄到收件排程',
      schedule: schedule
    });
    
  } catch (error) {
    console.error('新增收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📋 取得收件排程列表
app.get('/api/pickup-schedule/orders', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    // 依日期分組
    const grouped = {};
    data.schedules.forEach(schedule => {
      const date = schedule.pickupDate;
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(schedule);
    });
    
    res.json({ 
      success: true, 
      schedules: data.schedules,
      grouped: grouped
    });
    
  } catch (error) {
    console.error('載入收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ 標記已收件（並通知客人）
app.post('/api/pickup-schedule/complete', async (req, res) => {
  const { id, notifyCustomer } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const schedule = data.schedules.find(s => s.id === id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    schedule.status = 'completed';
    schedule.completedAt = new Date().toISOString();
    
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    // 如果要通知客人
    if (notifyCustomer && schedule.userId) {
      await client.pushMessage(schedule.userId, {
        type: 'text',
        text: '✅ 您的衣物已收到！\n我們會盡快為您處理，完成後會再通知您取件 💙'
      });
    }
    
    res.json({ 
      success: true, 
      message: notifyCustomer ? '✅ 已標記完成並通知客人' : '✅ 已標記完成'
    });
    
  } catch (error) {
    console.error('標記完成失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🗑️ 刪除收件排程
app.delete('/api/pickup-schedule/order/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const index = data.schedules.findIndex(s => s.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    data.schedules.splice(index, 1);
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ success: true, message: '✅ 已刪除收件排程' });
    
  } catch (error) {
    console.error('刪除收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✏️ 編輯收件排程
app.post('/api/pickup-schedule/update', async (req, res) => {
  const { id, note, pickupDate } = req.body;
  
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const schedule = data.schedules.find(s => s.id === id);
    if (!schedule) {
      return res.status(404).json({ success: false, error: '找不到此記錄' });
    }
    
    if (note !== undefined) schedule.note = note;
    if (pickupDate !== undefined) schedule.pickupDate = pickupDate;
    
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    res.json({ success: true, message: '✅ 已更新收件排程' });
    
  } catch (error) {
    console.error('更新收件排程失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📊 取得今日收件提醒
app.get('/api/pickup-schedule/today-alert', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const FILE_PATH = path.join(__dirname, 'data', 'pickup-schedule.json');
    
    let data = { schedules: [] };
    if (fs.existsSync(FILE_PATH)) {
      data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
    
    const today = new Date().toISOString().split('T')[0];
    const todaySchedules = data.schedules.filter(s => 
      s.pickupDate === today && s.status === 'pending'
    );
    
    const aiCount = todaySchedules.filter(s => s.source === 'ai').length;
    const customerCount = todaySchedules.filter(s => s.source === 'customer').length;
    
    res.json({
      success: true,
      total: todaySchedules.length,
      aiCount: aiCount,
      customerCount: customerCount,
      schedules: todaySchedules
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 🚀 一鍵啟動服務 API
// ========================================
app.post('/api/start-services', async (req, res) => {
  try {
    const axios = require('axios');
    const ngrokUrl = 'https://fbe0-61-219-57-189.ngrok-free.app';
    
    console.log('🔗 正在連線到電腦:', ngrokUrl);
    
    const response = await axios.post(`${ngrokUrl}/start`, {}, { 
      timeout: 10000 
    });
    
    res.json({ 
      success: true, 
      message: '✅ 電腦已收到指令,正在啟動 4 個服務...' 
    });
    
  } catch (error) {
    console.error('❌ 連線失敗:', error.message);
    res.json({ 
      success: false, 
      error: '❌ 無法連線到電腦\n\n請確認:\n1. 電腦是否開機\n2. 桌面的「啟動.bat」是否執行中' 
    });
  }
});
// ===== 財經新聞圖片產生路由 =====
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.post('/api/news/image', async (req, res) => {
  try {
    const { date, alert, indices, asia, rates, commodities, fx, outlook, advice } = req.body;
    const urls = [];
    const browser = await puppeteer.launch({
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process'
  ],
  executablePath: await chromium.executablePath(),
  headless: true,
});

    const htmls = [
      generateCard1(date, alert, indices, asia, rates),
      generateCard2(date, commodities, fx, outlook),
      generateCard3(date, advice)
    ];

    for (let i = 0; i < htmls.length; i++) {
      const page = await browser.newPage();
      await page.setViewport({ width: 720, height: 1000 });
      await page.setContent(htmls[i], { waitUntil: 'networkidle0' });
      const buffer = await page.screenshot({ fullPage: true });
      await page.close();

      const result = await new Promise((resolve, reject) => {
  const uploadStream = cloudinary.uploader.upload_stream(
    { folder: 'finance_news', resource_type: 'image' },
    (error, result) => error ? reject(error) : resolve(result)
  );
  const { Readable } = require('stream');
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  readable.pipe(uploadStream);
});
urls.push(result.secure_url);
    }

    await browser.close();
    res.json({ success: true, urls });
  } catch (err) {
    console.error('圖片產生失敗:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function generateCard1(date, alert, indices, asia, rates) {
  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900&family=Playfair+Display:wght@700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:720px;font-family:'Noto Sans TC',sans-serif;}
.wrap{width:720px;background:#fff;}
.header{background:linear-gradient(135deg,#0f1f45,#1a3366);padding:28px 36px 24px;}
.h-date{font-size:12px;color:rgba(255,255,255,0.45);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;}
.h-title{font-family:'Playfair Display',serif;font-size:30px;color:#fff;line-height:1.15;}
.h-row{display:flex;justify-content:space-between;align-items:flex-start;}
.h-right{display:flex;flex-direction:column;align-items:flex-end;gap:7px;margin-top:4px;}
.h-sub{font-size:12.5px;color:rgba(255,255,255,0.4);margin-top:7px;}
.badge{font-size:11px;font-weight:800;padding:5px 13px;border-radius:20px;letter-spacing:1.5px;text-transform:uppercase;}
.badge-pro{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.9);}
.badge-p{background:rgba(99,179,237,0.2);border:1px solid rgba(99,179,237,0.35);color:#93c5fd;}
.alert{background:linear-gradient(90deg,#fff5f5,#fffafa);border-left:5px solid #dc2626;border-bottom:1px solid #fecaca;padding:16px 36px;display:flex;gap:13px;}
.alert-icon{font-size:22px;flex-shrink:0;}
.alert-label{font-size:11px;font-weight:800;color:#dc2626;letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;}
.alert-text{font-size:14px;color:#374151;line-height:1.75;}
.alert-text b{color:#dc2626;}
.index-strip{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #f0f2f5;background:#fafbfd;}
.idx{padding:16px 10px;text-align:center;border-right:1px solid #f0f2f5;}
.idx:last-child{border-right:none;}
.idx-name{font-size:10.5px;font-weight:700;color:#9ca3af;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;}
.idx-val{font-size:17px;font-weight:800;margin-bottom:4px;}
.idx-chg{font-size:12px;font-weight:700;padding:3px 8px;border-radius:8px;display:inline-block;}
.dn{color:#dc2626;}.dn-bg{background:#fef2f2;color:#dc2626;}
.up{color:#059669;}.up-bg{background:#ecfdf5;color:#059669;}
.wn{color:#d97706;}.wn-bg{background:#fffbeb;color:#d97706;}
.body{padding:0 36px 36px;}
.sec{padding:20px 0;border-bottom:1px solid #f3f4f6;}
.sec:last-of-type{border-bottom:none;padding-bottom:0;}
.sec-hd{display:flex;align-items:center;gap:10px;margin-bottom:15px;}
.sec-ico{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.ic-red{background:#fef2f2;}.ic-blue{background:#eff6ff;}
.sec-title{font-size:13.5px;font-weight:800;color:#1f2937;}
.sec-tag{margin-left:auto;font-size:11px;font-weight:700;color:#9ca3af;background:#f3f4f6;padding:3px 10px;border-radius:10px;}
.row{display:flex;padding:9px 0;border-bottom:1px dashed #f3f4f6;align-items:flex-start;}
.row:last-child{border-bottom:none;padding-bottom:0;}
.rk{font-size:12px;font-weight:700;color:#6b7280;min-width:95px;padding-top:2px;flex-shrink:0;}
.rv{font-size:13.5px;color:#1f2937;line-height:1.7;flex:1;}
.rv b{color:#dc2626;font-weight:700;}
.rv .g{color:#059669;font-weight:700;}
.rv .w{color:#d97706;font-weight:700;}
.hist{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:11px;padding:15px 18px;margin-top:14px;}
.hist-title{font-size:11px;font-weight:800;color:#059669;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;}
.hist-row{display:flex;justify-content:space-between;font-size:13px;color:#374151;padding:5px 0;border-bottom:1px dashed #d1fae5;}
.hist-row:last-child{border-bottom:none;padding-bottom:0;}
.hist-row span:first-child{color:#6b7280;font-weight:600;}
.hist-row span:last-child{font-weight:700;color:#065f46;}
.page-ind{background:#0f1f45;padding:11px 36px;display:flex;justify-content:space-between;align-items:center;}
.page-text{font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1px;}
.page-dots{display:flex;gap:6px;}
.dot{width:20px;height:4px;border-radius:2px;}
.dot-on{background:#93c5fd;}.dot-off{background:rgba(255,255,255,0.2);}
</style></head><body><div class="wrap">
<div class="header"><div class="h-row"><div>
<div class="h-date">${date}</div>
<div class="h-title">國際財經速報</div>
<div class="h-sub">海外債券 · FCN 投資人專用 · 理專版</div>
</div><div class="h-right">
<span class="badge badge-pro">理專 PRO</span>
<span class="badge badge-p">① 今日市況</span>
</div></div></div>
<div class="alert"><div class="alert-icon">🚨</div><div>
<div class="alert-label">今日最大變數</div>
<div class="alert-text">${alert}</div>
</div></div>
<div class="index-strip">
${indices.map(idx => `<div class="idx"><div class="idx-name">${idx.name}</div><div class="idx-val ${idx.dir}">${idx.value}</div><div class="idx-chg ${idx.dir}-bg">${idx.change}</div></div>`).join('')}
</div>
<div class="body">
<div class="sec"><div class="sec-hd"><div class="sec-ico ic-red">🔥</div><span class="sec-title">亞股重大事件</span><span class="sec-tag">本週最大衝擊</span></div>
${asia.map(r => `<div class="row"><span class="rk">${r.key}</span><span class="rv">${r.val}</span></div>`).join('')}
</div>
<div class="sec"><div class="sec-hd"><div class="sec-ico ic-blue">💵</div><span class="sec-title">美元 · 利率 · 債券</span><span class="sec-tag">持債客戶必看</span></div>
${rates.rows.map(r => `<div class="row"><span class="rk">${r.key}</span><span class="rv">${r.val}</span></div>`).join('')}
<div class="hist"><div class="hist-title">📊 歷史數據比對：油價衝擊 vs 債市</div>
${rates.history.map(r => `<div class="hist-row"><span>${r.period}</span><span>${r.result}</span></div>`).join('')}
</div></div>
</div>
<div class="page-ind"><span class="page-text">第 1 張，共 3 張</span><div class="page-dots"><div class="dot dot-on"></div><div class="dot dot-off"></div><div class="dot dot-off"></div></div></div>
</div></body></html>`;
}

function generateCard2(date, commodities, fx, outlook) {
  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900&family=Playfair+Display:wght@700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:720px;font-family:'Noto Sans TC',sans-serif;}
.wrap{width:720px;background:#fff;}
.header-mini{background:linear-gradient(135deg,#0f1f45,#1a3366);padding:17px 36px;display:flex;justify-content:space-between;align-items:center;}
.hm-title{font-family:'Playfair Display',serif;font-size:19px;color:rgba(255,255,255,0.85);}
.hm-right{display:flex;gap:8px;}
.badge{font-size:11px;font-weight:800;padding:5px 13px;border-radius:20px;letter-spacing:1.5px;text-transform:uppercase;}
.badge-pro{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.9);}
.badge-p{background:rgba(252,211,77,0.2);border:1px solid rgba(252,211,77,0.35);color:#fcd34d;}
.body{padding:0 36px 36px;}
.sec{padding:20px 0;border-bottom:1px solid #f3f4f6;}
.sec:last-of-type{border-bottom:none;padding-bottom:0;}
.sec-hd{display:flex;align-items:center;gap:10px;margin-bottom:15px;}
.sec-ico{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.ic-amber{background:#fffbeb;}.ic-green{background:#ecfdf5;}.ic-purple{background:#f5f3ff;}
.sec-title{font-size:13.5px;font-weight:800;color:#1f2937;}
.sec-tag{margin-left:auto;font-size:11px;font-weight:700;color:#9ca3af;background:#f3f4f6;padding:3px 10px;border-radius:10px;}
.row{display:flex;padding:9px 0;border-bottom:1px dashed #f3f4f6;align-items:flex-start;}
.row:last-child{border-bottom:none;padding-bottom:0;}
.rk{font-size:12px;font-weight:700;color:#6b7280;min-width:95px;padding-top:2px;flex-shrink:0;}
.rv{font-size:13.5px;color:#1f2937;line-height:1.7;flex:1;}
.rv b{color:#dc2626;font-weight:700;}
.rv .g{color:#059669;font-weight:700;}
.rv .w{color:#d97706;font-weight:700;}
.dn{color:#dc2626;}.up{color:#059669;}.wn{color:#d97706;}
.dn-bg{background:#fef2f2;color:#dc2626;}.up-bg{background:#ecfdf5;color:#059669;}.wn-bg{background:#fffbeb;color:#d97706;}
.prob{background:#f8f9fc;border:1px solid #eef0f5;border-radius:11px;padding:15px 18px;margin-top:14px;}
.prob-title{font-size:11px;font-weight:800;color:#6b7280;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:13px;}
.prob-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.pi{text-align:center;}
.pi-name{font-size:11px;color:#9ca3af;font-weight:600;margin-bottom:6px;}
.bar-wrap{height:7px;background:#e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:6px;}
.bar{height:100%;border-radius:10px;}
.br{background:linear-gradient(90deg,#dc2626,#f87171);}
.bg{background:linear-gradient(90deg,#059669,#34d399);}
.ba{background:linear-gradient(90deg,#d97706,#fbbf24);}
.pi-pct{font-size:16px;font-weight:800;}
.pi-desc{font-size:11px;color:#9ca3af;margin-top:3px;}
.fx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-top:14px;}
.fx-card{background:#f8f9fc;border:1px solid #eef0f5;border-radius:10px;padding:14px 15px;}
.fx-pair{font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:1px;margin-bottom:5px;}
.fx-val{font-size:18px;font-weight:800;color:#1f2937;margin-bottom:3px;}
.fx-chg{font-size:12px;font-weight:600;}
.t{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;margin:0 2px;vertical-align:middle;}
.t-amber{background:#fffbeb;color:#d97706;}.t-green{background:#ecfdf5;color:#059669;}
.page-ind{background:#0f1f45;padding:11px 36px;display:flex;justify-content:space-between;align-items:center;}
.page-text{font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1px;}
.page-dots{display:flex;gap:6px;}
.dot{width:20px;height:4px;border-radius:2px;}
.dot-on{background:#fcd34d;}.dot-off{background:rgba(255,255,255,0.2);}
</style></head><body><div class="wrap">
<div class="header-mini"><span class="hm-title">國際財經速報</span><div class="hm-right"><span class="badge badge-pro">理專 PRO</span><span class="badge badge-p">② 深度分析</span></div></div>
<div class="body">
<div class="sec"><div class="sec-hd"><div class="sec-ico ic-amber">🛢️</div><span class="sec-title">大宗商品</span><span class="sec-tag">能源 · 貴金屬</span></div>
${commodities.rows.map(r => `<div class="row"><span class="rk">${r.key}</span><span class="rv">${r.val}</span></div>`).join('')}
<div class="prob"><div class="prob-title">⚡ 油價後市機率預估</div><div class="prob-grid">
${commodities.probs.map(p => `<div class="pi"><div class="pi-name">${p.name}</div><div class="bar-wrap"><div class="bar ${p.color}" style="width:${p.pct}%"></div></div><div class="pi-pct ${p.textColor}">${p.pct}%</div><div class="pi-desc">${p.desc}</div></div>`).join('')}
</div></div></div>
<div class="sec"><div class="sec-hd"><div class="sec-ico ic-green">💱</div><span class="sec-title">主要外匯</span><span class="sec-tag">本週收盤</span></div>
<div class="fx-grid">
${fx.map(f => `<div class="fx-card"><div class="fx-pair">${f.pair}</div><div class="fx-val">${f.value}</div><div class="fx-chg ${f.dir}">${f.change}</div></div>`).join('')}
</div></div>
<div class="sec"><div class="sec-hd"><div class="sec-ico ic-purple">📈</div><span class="sec-title">美股後市展望</span><span class="sec-tag">機構觀點</span></div>
${outlook.rows.map(r => `<div class="row"><span class="rk">${r.key}</span><span class="rv">${r.val}</span></div>`).join('')}
<div class="prob" style="margin-top:13px"><div class="prob-title">📉 S&P500 未來一個月方向預估</div><div class="prob-grid">
${outlook.probs.map(p => `<div class="pi"><div class="pi-name">${p.name}</div><div class="bar-wrap"><div class="bar ${p.color}" style="width:${p.pct}%"></div></div><div class="pi-pct ${p.textColor}">${p.pct}%</div><div class="pi-desc">${p.desc}</div></div>`).join('')}
</div></div></div>
</div>
<div class="page-ind"><span class="page-text">第 2 張，共 3 張</span><div class="page-dots"><div class="dot dot-off"></div><div class="dot dot-on"></div><div class="dot dot-off"></div></div></div>
</div></body></html>`;
}

function generateCard3(date, advice) {
  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700;900&family=Playfair+Display:wght@700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:720px;font-family:'Noto Sans TC',sans-serif;}
.wrap{width:720px;background:#fff;}
.header-mini{background:linear-gradient(135deg,#0f1f45,#1a3366);padding:17px 36px;display:flex;justify-content:space-between;align-items:center;}
.hm-title{font-family:'Playfair Display',serif;font-size:19px;color:rgba(255,255,255,0.85);}
.hm-right{display:flex;gap:8px;}
.badge{font-size:11px;font-weight:800;padding:5px 13px;border-radius:20px;letter-spacing:1.5px;text-transform:uppercase;}
.badge-pro{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.9);}
.badge-p{background:rgba(167,243,208,0.2);border:1px solid rgba(167,243,208,0.35);color:#6ee7b7;}
.body{padding:28px 36px 36px;}
.sec-hd{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
.sec-ico{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;background:#f0fdf4;}
.sec-title{font-size:14px;font-weight:800;color:#1f2937;}
.sec-sub{margin-left:auto;font-size:11px;color:#9ca3af;}
.advice{border:1px solid #e5e7eb;border-radius:13px;overflow:hidden;}
.adv-hd{background:linear-gradient(135deg,#0f1f45,#1a3366);padding:15px 22px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);letter-spacing:1.5px;text-transform:uppercase;}
.adv-row{display:flex;align-items:flex-start;padding:14px 22px;border-top:1px solid #f3f4f6;gap:14px;}
.adv-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;margin-top:5px;}
.adv-type{font-size:12.5px;font-weight:700;color:#6b7280;min-width:100px;flex-shrink:0;padding-top:2px;}
.adv-div{color:#d1d5db;font-size:16px;padding-top:1px;}
.adv-text{font-size:13.5px;color:#1f2937;line-height:1.65;flex:1;}
.adv-text b{color:#dc2626;}
.adv-text .g{color:#059669;font-weight:700;}
.footer{background:#f8f9fc;border-top:1px solid #eef0f5;padding:14px 36px;display:flex;justify-content:space-between;align-items:center;margin-top:24px;}
.ft-brand{font-size:12px;color:#9ca3af;}
.ft-note{font-size:11px;color:#d1d5db;text-align:right;line-height:1.6;}
.page-ind{background:#0f1f45;padding:11px 36px;display:flex;justify-content:space-between;align-items:center;}
.page-text{font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:1px;}
.page-dots{display:flex;gap:6px;}
.dot{width:20px;height:4px;border-radius:2px;}
.dot-on{background:#6ee7b7;}.dot-off{background:rgba(255,255,255,0.2);}
</style></head><body><div class="wrap">
<div class="header-mini"><span class="hm-title">國際財經速報</span><div class="hm-right"><span class="badge badge-pro">理專 PRO</span><span class="badge badge-p">③ 客戶建議</span></div></div>
<div class="body">
<div class="sec-hd"><div class="sec-ico">📋</div><span class="sec-title">本週對客戶說話建議</span><span class="sec-sub">${date}</span></div>
<div class="advice"><div class="adv-hd">📋 依客戶狀況分類建議</div>
${advice.map(a => `<div class="adv-row"><div class="adv-dot" style="background:${a.color}"></div><span class="adv-type">${a.type}</span><span class="adv-div">｜</span><span class="adv-text">${a.text}</span></div>`).join('')}
</div>
<div class="footer"><span class="ft-brand">國際財經速報 · 理專專用版</span><span class="ft-note">資料整理：${date} 08:00<br>僅供參考，不構成投資建議</span></div>
</div>
<div class="page-ind"><span class="page-text">第 3 張，共 3 張</span><div class="page-dots"><div class="dot dot-off"></div><div class="dot dot-off"></div><div class="dot dot-on"></div></div></div>
</div></body></html>`;
}
// ===== 財經新聞圖片路由結束 =====





const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`伺服器正在運行,端口:${PORT}`);
  logger.logToFile(`伺服器正在運行,端口:${PORT}`);

// 🧺 初始化取件追蹤
  pickupRoutes.setLineClient(client);
  setInterval(() => {
  pickupRoutes.checkAndSendReminders();
  }, 60 * 60 * 1000);
  console.log('✅ 取件追蹤系統已啟動');
  try {
    await customerDB.loadAllCustomers();
    console.log('客戶資料載入完成');
  } catch (error) {
    console.error('客戶資料載入失敗:', error.message);
  }

  setInterval(() => {
    orderManager.cleanExpiredOrders();
  }, 24 * 60 * 60 * 1000);

  setInterval(async () => {
    const ordersNeedingReminder = orderManager.getOrdersNeedingReminder();
    if (ordersNeedingReminder.length === 0) return;

    logger.logToFile(`檢測到 ${ordersNeedingReminder.length} 筆訂單需要提醒`);

    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '';
    const baseURL = ensureHttpsBase(rawBase) || 'https://stain-bot-production-2593.up.railway.app';

    for (const order of ordersNeedingReminder) {
      try {
        const linepayPersistentUrl = `${baseURL}/payment/linepay/pay/${order.orderId}`;
        const ecpayPersistentUrl = `${baseURL}/payment/ecpay/pay/${order.orderId}`;

        let linepayShort = linepayPersistentUrl;
        let ecpayShort = ecpayPersistentUrl;

        try {
          const r1 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(linepayPersistentUrl)}`);
          const t1 = await r1.text();
          if (t1 && t1.startsWith('http')) linepayShort = t1;
        } catch {
          logger.logToFile(`LINE Pay 短網址生成失敗,使用原網址`);
        }

        try {
          const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ecpayPersistentUrl)}`);
          const t2 = await r2.text();
          if (t2 && t2.startsWith('http')) ecpayShort = t2;
        } catch {
          logger.logToFile(`綠界短網址失敗，使用原網址`);
        }

        const reminderText =
          `溫馨付款提醒\n\n` +
          `親愛的 ${order.userName} 您好，您於本次洗衣清潔仍待付款\n` +
          `金額：NT$ ${order.amount.toLocaleString()}\n\n` +
          `【信用卡／綠界】\n${ecpayShort}\n\n` +
          `【LINE Pay】\n${linepayShort}\n\n` +
          `備註：以上連結有效期間內可重複點擊付款。\n` +
          `若已完成付款，請忽略此訊息。感謝您的支持 💙`;

        await client.pushMessage(order.userId, { type: 'text', text: reminderText });

        logger.logToFile(`自動發送付款提醒：${order.orderId} (第 ${order.reminderCount + 1} 次)`);
        orderManager.markReminderSent(order.orderId);
      } catch (error) {
        logger.logError(`自動提醒失敗: ${order.orderId}`, error);
      }
    }
  }, 2 * 60 * 60 * 1000);
});
// ====================================
// 每週 AI 客服分析報告
// ====================================
const cron = require('node-cron');
const weeklyAnalysis = require('./services/weeklyAnalysis');
const reportGenerator = require('./services/reportGenerator');

// 每週日晚上 8 點執行（台北時間）
cron.schedule('0 20 * * 0', async () => {
  console.log('🔍 開始生成每週 AI 客服分析報告...');
  
  try {
    // 1. 分析數據
    const analysis = await weeklyAnalysis.analyzeWeeklyData();
    
    if (!analysis || analysis.error) {
      console.log('⚠️ 週報生成失敗:', analysis?.error || '未知錯誤');
      return;
    }

    // 2. 生成優化建議
    console.log('💡 正在生成 AI 優化建議...');
    const suggestions = await reportGenerator.generateSuggestions(analysis);
    
    // 3. 格式化報告
    const report = reportGenerator.formatReport(analysis, suggestions);
    
    // 4. 發送到 LINE
    if (process.env.ADMIN_USER_ID) {
      await client.pushMessage(process.env.ADMIN_USER_ID, {
        type: 'text',
        text: report
      });
      console.log('✅ 週報已發送到 LINE');
    }
    
    logger.logToFile('✅ 週報生成成功');
    
  } catch (error) {
    console.error('❌ 週報生成失敗:', error);
    logger.logError('週報生成失敗', error);
  }
}, {
  timezone: "Asia/Taipei"
});

console.log('⏰ 每週報告排程已啟動（每週日 20:00）');

// 🔥 測試用:手動觸發需求預測報表 (整合 LINE 推播版)
app.get('/api/test-forecast', async (req, res) => {
  try {
    console.log('🔍 手動觸發需求預測報表...');
    
    const { main: generateForecast } = require('./demand-forecast-system');
    const result = await generateForecast();
    
    // 🔥 發送 LINE 推播
    if (result.success && result.lineReport) {
      try {
        // 發送給管理員
        if (process.env.ADMIN_USER_ID) {
          await client.pushMessage(process.env.ADMIN_USER_ID, {
            type: 'text',
            text: result.lineReport
          });
          console.log('✅ LINE 報表已發送給管理員');
        }
      } catch (lineError) {
        console.error('❌ LINE 發送失敗:', lineError.message);
      }
    }
    
    res.json({
      success: true,
      message: '需求預測報表已生成',
      emailSent: result.emailSent || false,
      lineSent: !!process.env.ADMIN_USER_ID,
      preview: result.lineReport ? result.lineReport.substring(0, 200) + '...' : '',
      note: result.emailSent ? 'Email 已發送' : 'Email 發送失敗 (Railway 封鎖 SMTP),但 LINE 已發送'
    });
    
  } catch (error) {
    console.error('手動預測報表生成失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🔥 測試用:手動觸發月度報告  ⬅️ 在這裡加入!
app.get('/api/test-monthly-report', async (req, res) => {
  try {
    console.log('📊 手動觸發月度報告...');
    
    const { main: generateMonthlyReport } = require('./monthly-report-system');
    const result = await generateMonthlyReport();
    
    // 發送 LINE 推播
    if (result.success && result.lineReport) {
      try {
        if (process.env.ADMIN_USER_ID) {
          await client.pushMessage(process.env.ADMIN_USER_ID, {
            type: 'text',
            text: result.lineReport
          });
          console.log('✅ LINE 報表已發送給管理員');
        }
      } catch (lineError) {
        console.error('❌ LINE 發送失敗:', lineError.message);
      }
    }
    
    res.json({
      success: true,
      message: '月度報告已生成',
      preview: result.lineReport ? result.lineReport.substring(0, 200) + '...' : ''
    });
    
  } catch (error) {
    console.error('月度報告生成失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ====================================
// 每日需求預測報表 (整合 LINE 推播)
// ====================================
// 需求預測報表 - 每天早上 8:00
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ 開始生成需求預測報表...');
  
  try {
    const { main: generateForecast } = require('./demand-forecast-system');
    const result = await generateForecast();
    
    // 🔥 發送 LINE 推播給管理員
   // 已停用 LINE 推播（由 Google Apps Script 統一發送）
    // if (result.success && result.lineReport && process.env.ADMIN_USER_ID) { ... }
    
    console.log('✅ 需求預測報表生成完成');
  } catch (error) {
    console.error('❌ 需求預測報表失敗:', error.message);
    logger.logError('需求預測報表失敗', error);
  }
}, {
  timezone: "Asia/Taipei"
});

console.log('⏰ 需求預測報表排程已啟動(每天 08:00)');

// 🔥 測試用:手動觸發需求預測報表 (整合 LINE 推播版)
app.get('/api/test-forecast', async (req, res) => {
  try {
    console.log('🔍 手動觸發需求預測報表...');
    
    const { main: generateForecast } = require('./demand-forecast-system');
    const result = await generateForecast();
    
    // 🔥 發送 LINE 推播
    if (result.success && result.lineReport) {
      try {
        // 發送給管理員
        if (process.env.ADMIN_USER_ID) {
          await client.pushMessage(process.env.ADMIN_USER_ID, {
            type: 'text',
            text: result.lineReport
          });
          console.log('✅ LINE 報表已發送給管理員');
        }
      } catch (lineError) {
        console.error('❌ LINE 發送失敗:', lineError.message);
      }
    }
    
    res.json({
      success: true,
      message: '需求預測報表已生成',
      emailSent: result.emailSent || false,
      lineSent: !!process.env.ADMIN_USER_ID,
      preview: result.lineReport ? result.lineReport.substring(0, 200) + '...' : '',
      note: result.emailSent ? '✅ Email 和 LINE 都已發送' : '⚠️ Email 發送狀態未知,請檢查信箱'
    });
    
  } catch (error) {
    console.error('手動預測報表生成失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🔍 測試 token 詳細資訊
app.get('/test-token-detail', async (req, res) => {
  try {
    const googleAuth = require('./services/googleAuth');
    const oauth2Client = googleAuth.getOAuth2Client();
    
    const creds = oauth2Client.credentials;
    
    res.json({
      hasToken: !!creds,
      hasAccessToken: !!creds?.access_token,
      hasRefreshToken: !!creds?.refresh_token,
      scopes: creds?.scope?.split(' ') || [],
      expiry: creds?.expiry_date ? new Date(creds.expiry_date).toISOString() : null,
      tokenType: creds?.token_type
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-auth-email', async (req, res) => {
  try {
    const googleAuth = require('./services/googleAuth');
    const { google } = require('googleapis');
    const auth = googleAuth.getOAuth2Client();
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    
    res.json({
      email: userInfo.data.email,
      name: userInfo.data.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================================
// 每月營收對比報告
// ====================================
// 每月 1 號早上 9:00 執行
cron.schedule('0 9 1 * *', async () => {
  console.log('📊 開始生成月度營收報告...');
  
  try {
    const { main: generateMonthlyReport } = require('./monthly-report-system');
    const result = await generateMonthlyReport();
    
    // 發送 LINE 推播給管理員
    if (result.success && result.lineReport && process.env.ADMIN_USER_ID) {
      try {
        await client.pushMessage(process.env.ADMIN_USER_ID, {
          type: 'text',
          text: result.lineReport
        });
        console.log('✅ 月度報告已發送到 LINE');
      } catch (lineError) {
        console.error('❌ LINE 發送失敗:', lineError.message);
      }
    }
    
    console.log('✅ 月度報告生成完成');
  } catch (error) {
    console.error('❌ 月度報告失敗:', error.message);
    logger.logError('月度報告失敗', error);
  }
}, {
  timezone: "Asia/Taipei"
});

console.log('📊 月度營收報告排程已啟動 (每月 1 號 09:00)');

// ========================================
// 📊 品項分析 API
// ========================================
app.get('/api/item-analysis', async (req, res) => {
  try {
    const { range, date } = req.query; // range: 'daily' | 'weekly' | 'monthly'
    if (!range) return res.status(400).json({ success: false, error: '缺少 range 參數' });

    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const targetSheet = sheetInfo.data.sheets.find(s => s.properties.sheetId === 756780563);
    if (!targetSheet) return res.status(500).json({ success: false, error: '找不到營業紀錄工作表' });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${targetSheet.properties.title}'!A:I`
    });

    const rows = (response.data.values || []).slice(1);
    const now = new Date();
    const baseDate = date ? new Date(date) : now;

    // 計算時間範圍
    let startDate, endDate;
    if (range === 'daily') {
      const d = baseDate.toISOString().substring(0, 10);
      startDate = d; endDate = d;
    } else if (range === 'weekly') {
      const day = baseDate.getDay();
      const mon = new Date(baseDate); mon.setDate(baseDate.getDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      startDate = mon.toISOString().substring(0, 10);
      endDate = sun.toISOString().substring(0, 10);
    } else { // monthly
      const y = baseDate.getFullYear();
      const m = String(baseDate.getMonth() + 1).padStart(2, '0');
      startDate = `${y}-${m}-01`;
      endDate = `${y}-${m}-${new Date(y, baseDate.getMonth() + 1, 0).getDate()}`;
    }

    // 統計品項
    const itemCount = {};
    const itemRevenue = {};
    let totalCount = 0;

    rows.forEach(row => {
      if (!row[0] || !row[5]) return;
      const rowDate = row[0].toString().replace(/\//g, '-').substring(0, 10);
      if (rowDate < startDate || rowDate > endDate) return;

      const item = row[5].toString().trim();
      const amount = parseInt(String(row[8] || '0').replace(/[^0-9]/g, ''), 10) || 0;

      itemCount[item] = (itemCount[item] || 0) + 1;
      itemRevenue[item] = (itemRevenue[item] || 0) + amount;
      totalCount++;
    });

    // 排序
    const sorted = Object.entries(itemCount)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({
        name,
        count,
        revenue: itemRevenue[name] || 0,
        percent: totalCount > 0 ? Math.round(count / totalCount * 100) : 0
      }));

    res.json({
      success: true,
      range,
      startDate,
      endDate,
      totalCount,
      items: sorted
    });

  } catch (error) {
    console.error('品項分析錯誤:', error);
    res.json({ success: false, error: error.message });
  }
});

// 品項 AI 分析
app.post('/api/item-ai-analysis', async (req, res) => {
  try {
    const { range, startDate, endDate, items, totalCount } = req.body;
    if (!items || items.length === 0) return res.json({ success: false, error: '沒有品項資料' });

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const top10 = items.slice(0, 10).map(i => `${i.name}: ${i.count} 件 (${i.percent}%, NT$${i.revenue.toLocaleString()})`).join('\n');
    const rangeLabel = range === 'daily' ? '當日' : range === 'weekly' ? '本週' : '本月';

    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `你是 C.H 精緻洗衣的市場分析顧問，請根據以下${rangeLabel}（${startDate} ~ ${endDate}）清潔品項數據，用繁體中文提供專業分析報告。

【${rangeLabel}品項統計】（共 ${totalCount} 件）
${top10}

請提供以下四個面向的分析（每點 2-3 句，直接切入重點）：

1. 🔥 最熱門品項趨勢（哪些品項占主力、為什麼）
2. 🌱 季節性變化洞察（依品項推測目前季節特徵）
3. 👥 客戶行為洞察（客人送洗習慣、品項組合模式）
4. 💡 定價與促銷建議（針對高頻品項的具體建議）`
      }]
    });

    res.json({ success: true, analysis: aiResponse.content[0].text });
  } catch (error) {
    console.error('品項 AI 分析錯誤:', error);
    res.json({ success: false, error: error.message });
  }
});

// 每日 AI 深度分析
app.get('/api/daily-ai-insight', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '缺少日期參數' });

    const { google } = require('googleapis');
const googleAuth = require('./services/googleAuth');
const auth = googleAuth.getOAuth2Client();
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
const targetSheet = sheetInfo.data.sheets.find(s => s.properties.sheetId === 756780563);
if (!targetSheet) return res.status(500).json({ error: '找不到營業紀錄工作表' });

const response = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `'${targetSheet.properties.title}'!A:I`
});

const rows = (response.data.values || []).slice(1);
const dayRows = rows.filter(row => {
  if (!row[0]) return false;
  const d = row[0].toString().replace(/\//g, '-').substring(0, 10);
  return d === date;
});

const revenue = dayRows.reduce((sum, row) => {
  const cleaned = String(row[8] || '0').replace(/[^0-9]/g, '');
  return sum + (parseInt(cleaned, 10) || 0);
}, 0);
const orderCount = dayRows.length;
const avgOrder = orderCount > 0 ? Math.round(revenue / orderCount) : 0;
const topItems = '精緻洗衣服務';

    const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const aiResponse = await anthropic.messages.create({
  model: 'claude-opus-4-5',
  max_tokens: 600,
  messages: [{
    role: 'user',
    content: `你是一位專精台灣精緻洗衣市場的資深分析師，服務對象是 C.H 精緻洗衣的店長。
以下是 ${date} 的營業數據：
- 當日營收：NT$${revenue}
- 訂單筆數：${orderCount} 筆
- 平均客單價：NT$${avgOrder} 元
- 主要洗滌品項：${topItems}

請以市場分析師角度，用繁體中文提供以下報告（語氣專業、精準、有數據依據）：

1. 📊 當日營業表現評估（對比精緻洗衣業一般行情）
2. 🔍 異常或值得關注的指標（如客單價過低、訂單量異常等）
3. 💡 明日可執行的具體策略建議（含針對精緻洗衣市場的洞察）

回答請簡潔有力，每點不超過 3 句，直接切入重點。`
  }]
});

res.json({
  success: true,
  date,
  stats: { revenue, orderCount, avgOrder },
 insight: aiResponse.content[0].text
});

  } catch (error) {
    console.error('每日AI分析失敗:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================


// 🔹 API 1: 上傳污漬照片 (改用 Google Drive) - 完整修復版
// 🔹 API 1: 上傳污漬照片 (Base64 直接存 Sheets)
app.post('/api/stain-photos', async (req, res) => {
  try {
    const { photoBase64, thumbnailBase64, note, orderId } = req.body;
    
    if (!photoBase64) {
      return res.json({ success: false, error: '缺少照片資料' });
    }

    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    
    if (!googleAuth.isAuthorized()) {
      return res.json({ success: false, error: '尚未授權 Google Sheets' });
    }

    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    const photoId = 'STAIN_' + Date.now();
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    // 🔥 直接存 Base64，不上傳到 Drive
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: '污漬照片!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          photoId,
          '',  // fileId 留空
          photoBase64,  // 直接存 Base64
          note || '',
          timestamp,
          orderId || ''
        ]]
      }
    });

    console.log(`✅ 污漬照片已儲存: ${photoId}`);
    
    res.json({ 
      success: true, 
      photoId: photoId,
      imageUrl: photoBase64,
      message: '照片已儲存'
    });

  } catch (error) {
    console.error('上傳污漬照片失敗:', error);
    res.json({ success: false, error: error.message });
  }
});
// 🔹 API 2: 取得所有污漬照片 (修復版)
app.get('/api/stain-photos', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    
    if (!googleAuth.isAuthorized()) {
      return res.json({ success: false, error: '尚未授權 Google Sheets' });
    }

    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '污漬照片!A:F',
    });

    const rows = response.data.values || [];
    
    if (rows.length <= 1) {
      return res.json({ success: true, photos: [] });
    }

    const photos = rows.slice(1).map(row => {
  return {
    photoId: row[0] || '',
    fileId: row[1] || '',
    imageUrl: row[2] || '',  // 🔥 直接用 Base64
    note: row[3] || '',
    timestamp: row[4] || '',
    orderId: row[5] || ''
  };
}).reverse();

    res.json({ success: true, photos: photos, total: photos.length });

  } catch (error) {
    console.error('取得污漬照片失敗:', error);
    res.json({ success: false, error: error.message });
  }
});

   // 🔹 API 3: 刪除污漬照片
app.delete('/api/stain-photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    
    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    
    if (!googleAuth.isAuthorized()) {
      return res.json({ success: false, error: '尚未授權 Google Sheets' });
    }

    const auth = googleAuth.getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties'
    });

    let sheetId = 0;
    const targetSheet = sheetInfo.data.sheets.find(
      sheet => sheet.properties.title === '污漬照片'
    );
    
    if (targetSheet) {
      sheetId = targetSheet.properties.sheetId;
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '污漬照片!A:F',
    });

    const rows = response.data.values || [];
    let rowIndex = -1;
    let fileId = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === photoId) {
        rowIndex = i + 1;
        fileId = rows[i][1];
        break;
      }
    }

    if (!fileId) {
      return res.json({ success: false, error: '找不到此照片' });
    }

    try {
      await drive.files.delete({ fileId: fileId });
      console.log(`✅ 已從 Drive 刪除照片: ${fileId}`);
    } catch (driveError) {
      console.log(`⚠️ Drive 刪除失敗: ${driveError.message}`);
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex
            }
          }
        }]
      }
    });

    console.log(`✅ 已刪除污漬照片: ${photoId}`);
    
    res.json({ 
      success: true, 
      message: '照片已刪除'
    });

  } catch (error) {
    console.error('刪除污漬照片失敗:', error);
    res.json({ success: false, error: error.message });
  }
});

    // 🔹 API 4: 更新污漬照片備註
app.put('/api/stain-photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { note } = req.body;
    
    const { google } = require('googleapis');
    const googleAuth = require('./services/googleAuth');
    
    if (!googleAuth.isAuthorized()) {
      return res.json({ success: false, error: '尚未授權 Google Sheets' });
    }

    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

    // 找到這張照片的位置
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '污漬照片!A:F',
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === photoId) {
        rowIndex = i + 1; // Google Sheets 是 1-based
        break;
      }
    }

    if (rowIndex === -1) {
      return res.json({ success: false, error: '找不到此照片' });
    }

    // 更新備註（D 欄）
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `污漬照片!D${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[note || '']]
      }
    });

    console.log(`✅ 已更新照片備註: ${photoId}`);
    
    res.json({ 
      success: true, 
      message: '備註已更新'
    });

  } catch (error) {
    console.error('更新備註失敗:', error);
    res.json({ success: false, error: error.message });
  }
});

