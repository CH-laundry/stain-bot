// ========================================
// 🧺 取件追蹤路由 - 獨立檔案
// ========================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const PICKUP_FILE = '/data/pickup-tracking.json';
const DEFAULT_TEMPLATE = '親愛的 {客戶姓名}，您的衣物已清洗完成，請盡快來取件！訂單編號：{客戶編號}';

// LINE Client 會從外部傳入
let lineClient = null;

// 設定 LINE Client
function setLineClient(client) {
  lineClient = client;
}

// 確保資料檔存在
function ensurePickupFile() {
  const dir = path.dirname(PICKUP_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(PICKUP_FILE)) {
    fs.writeFileSync(PICKUP_FILE, JSON.stringify({ 
      orders: [], 
      template: DEFAULT_TEMPLATE 
    }, null, 2));
  }
}

// 讀取資料
function readData() {
  ensurePickupFile();
  try {
    const content = fs.readFileSync(PICKUP_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[PICKUP] 讀取資料失敗:', error);
    return { orders: [], template: DEFAULT_TEMPLATE };
  }
}

// 儲存資料
function saveData(data) {
  ensurePickupFile();
  try {
    fs.writeFileSync(PICKUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('[PICKUP] 儲存資料失敗:', error);
  }
}

// 計算下次提醒時間(X天後的11:00)
function getNextReminderTime(daysLater) {
  const now = new Date();
  const next = new Date(now.getTime() + daysLater * 24 * 60 * 60 * 1000);
  next.setHours(11, 0, 0, 0);
  
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  
  return next.toISOString();
}

// ========================================
// API 路由
// ========================================

// 取得所有追蹤訂單
router.get('/orders', (req, res) => {
  try {
    const data = readData();
    const orders = data.orders.map(order => {
      const daysPassed = Math.floor((Date.now() - new Date(order.notifiedAt).getTime()) / (1000 * 60 * 60 * 24));
      return { ...order, daysPassed };
    });
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 新增取件追蹤
router.post('/add', (req, res) => {
  const { customerNumber, customerName, userId, phone } = req.body;
  
  if (!customerNumber || !customerName || !userId) {
    return res.status(400).json({ success: false, message: '缺少必要欄位' });
  }
  
  const data = readData();
  
  // 檢查是否已存在
  const exists = data.orders.find(o => o.customerNumber === customerNumber);
  if (exists) {
    return res.json({ success: false, message: '此訂單已在追蹤清單中' });
  }
  
  const order = {
    customerNumber,
    customerName,
    userId,
    phone: phone || '',
    createdAt: new Date().toISOString(),
    notifiedAt: new Date().toISOString(),
    nextReminderAt: getNextReminderTime(7),
    reminderCount: 0,
    reminderHistory: [],
    pickedUp: false,
    note: ''
  };
  
  data.orders.push(order);
  saveData(data);
  
  console.log(`[PICKUP] ✅ 已加入追蹤：${customerNumber} - ${customerName}`);
  res.json({ success: true, message: '已加入取件追蹤,系統將在7天後自動提醒', order });
});

// 標記已簽收
router.post('/complete', (req, res) => {
  const { customerNumber } = req.body;
  
  if (!customerNumber) {
    return res.status(400).json({ success: false, message: '缺少客戶編號' });
  }
  
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return res.json({ success: false, message: '找不到此訂單' });
  }
  
  if (order.pickedUp) {
    return res.json({ success: false, message: '此訂單已簽收' });
  }
  
  order.pickedUp = true;
  order.pickedUpAt = new Date().toISOString();
  saveData(data);
  
  console.log(`[PICKUP] ✅ 已簽收：${customerNumber} - ${order.customerName}`);
  res.json({ success: true, message: '已標記為已簽收' });
});

// 刪除追蹤
router.delete('/order/:customerNumber', (req, res) => {
  const { customerNumber } = req.params;
  
  const data = readData();
  const index = data.orders.findIndex(o => o.customerNumber === customerNumber);
  
  if (index === -1) {
    return res.json({ success: false, message: '找不到此訂單' });
  }
  
  const removed = data.orders.splice(index, 1)[0];
  saveData(data);
  
  console.log(`[PICKUP] 🗑️ 已刪除：${customerNumber} - ${removed.customerName}`);
  res.json({ success: true, message: '已刪除追蹤' });
});

// 延遲提醒(改為14天後)
router.post('/delay', (req, res) => {
  const { customerNumber } = req.body;
  
  if (!customerNumber) {
    return res.status(400).json({ success: false, message: '缺少客戶編號' });
  }
  
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return res.json({ success: false, message: '找不到此訂單' });
  }
  
  if (order.pickedUp) {
    return res.json({ success: false, message: '此訂單已簽收,無需延遲' });
  }
  
  order.nextReminderAt = getNextReminderTime(14);
  saveData(data);
  
  console.log(`[PICKUP] ⏰ 已延遲：${customerNumber} - ${order.customerName}`);
  res.json({ success: true, message: '已延遲14天後提醒' });
});

// 立即發送提醒
router.post('/remind/:customerNumber', async (req, res) => {
  const { customerNumber } = req.params;
  
  if (!lineClient) {
    return res.status(500).json({ success: false, message: 'LINE Client 未初始化' });
  }
  
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return res.json({ success: false, message: '找不到此訂單' });
  }
  
  if (order.pickedUp) {
    return res.json({ success: false, message: '此訂單已簽收' });
  }
  
  const message = data.template
    .replace(/{客戶姓名}/g, order.customerName)
    .replace(/{客戶編號}/g, order.customerNumber);
  
  try {
    await lineClient.pushMessage(order.userId, {
      type: 'text',
      text: message
    });
    
    order.reminderCount++;
    order.reminderHistory.push({
      sentAt: new Date().toISOString(),
      message: message
    });
    order.nextReminderAt = getNextReminderTime(7);
    saveData(data);
    
    console.log(`[PICKUP] 📨 已發送提醒：${customerNumber} - ${order.customerName}`);
    res.json({ success: true, message: '提醒已發送' });
  } catch (error) {
    console.error(`[PICKUP] ❌ 發送失敗：${customerNumber}`, error);
    res.status(500).json({ success: false, message: '發送失敗：' + error.message });
  }
});

// 更新備註
router.post('/note', (req, res) => {
  const { customerNumber, note } = req.body;
  
  if (!customerNumber) {
    return res.status(400).json({ success: false, message: '缺少客戶編號' });
  }
  
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return res.json({ success: false, message: '找不到此訂單' });
  }
  
  order.note = note || '';
  saveData(data);
  
  res.json({ success: true, message: '備註已更新' });
});

// 取得提醒模板
router.get('/template', (req, res) => {
  try {
    const data = readData();
    res.json({ success: true, template: data.template || DEFAULT_TEMPLATE });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新提醒模板
router.post('/template', (req, res) => {
  const { template } = req.body;
  
  if (!template) {
    return res.status(400).json({ success: false, message: '缺少模板內容' });
  }
  
  const data = readData();
  data.template = template;
  saveData(data);
  
  console.log(`[PICKUP] 📝 提醒模板已更新`);
  res.json({ success: true, message: '模板已更新' });
});

// ========================================
// 自動提醒功能
// ========================================

async function checkAndSendReminders() {
  if (!lineClient) {
    console.log('[PICKUP] LINE Client 未初始化，跳過檢查');
    return;
  }
  
  const data = readData();
  const now = new Date();
  const currentHour = now.getHours();
  
  // 只在11點執行
  if (currentHour !== 11) {
    return;
  }
  
  let sent = 0;
  
  for (const order of data.orders) {
    if (order.pickedUp) continue;
    
    const nextReminder = new Date(order.nextReminderAt);
    
    if (now.toDateString() === nextReminder.toDateString()) {
      const message = data.template
        .replace(/{客戶姓名}/g, order.customerName)
        .replace(/{客戶編號}/g, order.customerNumber);
      
      try {
        await lineClient.pushMessage(order.userId, {
          type: 'text',
          text: message
        });
        
        order.reminderCount++;
        order.reminderHistory.push({
          sentAt: new Date().toISOString(),
          message: message
        });
        order.nextReminderAt = getNextReminderTime(7);
        sent++;
        
        console.log(`[PICKUP] ✅ 自動提醒已發送：${order.customerNumber} - ${order.customerName}`);
      } catch (error) {
        console.error(`[PICKUP] ❌ 自動提醒失敗：${order.customerNumber}`, error);
      }
    }
  }
  
  if (sent > 0) {
    saveData(data);
    console.log(`[PICKUP] 📊 本次共發送 ${sent} 筆取件提醒`);
  }
}

module.exports = {
  router,
  setLineClient,
  checkAndSendReminders
};
