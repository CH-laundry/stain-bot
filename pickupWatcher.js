// ========================================
// 🧺 取件追蹤系統核心模組
// ========================================
const fs = require('fs');
const path = require('path');

const PICKUP_FILE = '/data/pickup-tracking.json';
const DEFAULT_TEMPLATE = '親愛的 {客戶姓名}，您的衣物已清洗完成，請盡快來取件！訂單編號：{客戶編號}';

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
    return JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
  } catch (error) {
    return { orders: [], template: '親愛的 {客戶姓名}，您的衣物已清洗完成，請盡快來取件！訂單編號：{客戶編號}' };
  }
}

// 儲存資料
function saveData(data) {
  ensurePickupFile();
  fs.writeFileSync(PICKUP_FILE, JSON.stringify(data, null, 2));
}

// 新增取件追蹤
function addPickupOrder(customerNumber, customerName, userId, phone = '') {
  const data = readData();
  
  // 檢查是否已存在
  const exists = data.orders.find(o => o.customerNumber === customerNumber);
  if (exists) {
    return { success: false, message: '此訂單已在追蹤清單中' };
  }
  
  const order = {
    customerNumber,
    customerName,
    userId,
    phone,
    createdAt: new Date().toISOString(),
    nextReminderAt: getNextReminderTime(7), // 7天後的11:00
    reminderCount: 0,
    reminderHistory: [],
    pickedUp: false,
    note: ''
  };
  
  data.orders.push(order);
  saveData(data);
  
  console.log(`[PICKUP] ✅ 已加入追蹤：${customerNumber} - ${customerName}`);
  return { success: true, message: '已加入取件追蹤', order };
}

// 計算下次提醒時間(X天後的11:00)
function getNextReminderTime(daysLater) {
  const now = new Date();
  const next = new Date(now.getTime() + daysLater * 24 * 60 * 60 * 1000);
  next.setHours(11, 0, 0, 0);
  return next.toISOString();
}

// 標記已簽收
function markAsPickedUp(customerNumber) {
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return { success: false, message: '找不到此訂單' };
  }
  
  order.pickedUp = true;
  order.pickedUpAt = new Date().toISOString();
  saveData(data);
  
  console.log(`[PICKUP] ✅ 已簽收：${customerNumber} - ${order.customerName}`);
  return { success: true, message: '已標記為已簽收' };
}

// 刪除追蹤
function deleteOrder(customerNumber) {
  const data = readData();
  const index = data.orders.findIndex(o => o.customerNumber === customerNumber);
  
  if (index === -1) {
    return { success: false, message: '找不到此訂單' };
  }
  
  const removed = data.orders.splice(index, 1)[0];
  saveData(data);
  
  console.log(`[PICKUP] 🗑️ 已刪除：${customerNumber} - ${removed.customerName}`);
  return { success: true, message: '已刪除追蹤' };
}

// 延遲提醒(改為14天後)
function delayReminder(customerNumber) {
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return { success: false, message: '找不到此訂單' };
  }
  
  order.nextReminderAt = getNextReminderTime(14); // 14天後的11:00
  saveData(data);
  
  console.log(`[PICKUP] ⏰ 已延遲：${customerNumber} - ${order.customerName} (延至 ${order.nextReminderAt})`);
  return { success: true, message: '已延遲14天後提醒' };
}

// 立即發送提醒
function sendReminderNow(customerNumber, client) {
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return { success: false, message: '找不到此訂單' };
  }
  
  if (order.pickedUp) {
    return { success: false, message: '此訂單已簽收' };
  }
  
  const message = data.template
    .replace(/{客戶姓名}/g, order.customerName)
    .replace(/{客戶編號}/g, order.customerNumber);
  
  return client.pushMessage(order.userId, {
    type: 'text',
    text: message
  }).then(() => {
    order.reminderCount++;
    order.reminderHistory.push({
      sentAt: new Date().toISOString(),
      message: message
    });
    order.nextReminderAt = getNextReminderTime(7); // 下次7天後
    saveData(data);
    
    console.log(`[PICKUP] 📨 已發送提醒：${customerNumber} - ${order.customerName}`);
    return { success: true, message: '提醒已發送' };
  }).catch(error => {
    console.error(`[PICKUP] ❌ 發送失敗：${customerNumber}`, error);
    return { success: false, message: '發送失敗：' + error.message };
  });
}

// 自動檢查並發送提醒(每小時執行一次)
function checkAndSendReminders(client) {
  const data = readData();
  const now = new Date();
  let sent = 0;
  
  data.orders.forEach(order => {
    if (order.pickedUp) return; // 已簽收的不提醒
    
    const nextReminder = new Date(order.nextReminderAt);
    
    // 如果到了提醒時間
    if (now >= nextReminder) {
      const message = data.template
        .replace(/{客戶姓名}/g, order.customerName)
        .replace(/{客戶編號}/g, order.customerNumber);
      
      client.pushMessage(order.userId, {
        type: 'text',
        text: message
      }).then(() => {
        order.reminderCount++;
        order.reminderHistory.push({
          sentAt: new Date().toISOString(),
          message: message
        });
        order.nextReminderAt = getNextReminderTime(7); // 下次7天後
        saveData(data);
        sent++;
        console.log(`[PICKUP] ✅ 自動提醒已發送：${order.customerNumber} - ${order.customerName}`);
      }).catch(error => {
        console.error(`[PICKUP] ❌ 自動提醒失敗：${order.customerNumber}`, error);
      });
    }
  });
  
  if (sent > 0) {
    console.log(`[PICKUP] 📊 本次共發送 ${sent} 筆取件提醒`);
  }
}

// 更新備註
function updateNote(customerNumber, note) {
  const data = readData();
  const order = data.orders.find(o => o.customerNumber === customerNumber);
  
  if (!order) {
    return { success: false, message: '找不到此訂單' };
  }
  
  order.note = note;
  saveData(data);
  
  return { success: true, message: '備註已更新' };
}

// 更新提醒模板
function updateTemplate(template) {
  const data = readData();
  data.template = template;
  saveData(data);
  
  console.log(`[PICKUP] 📝 提醒模板已更新`);
  return { success: true, message: '模板已更新' };
}

// 取得所有訂單
function getAllOrders() {
  const data = readData();
  return data.orders.map(order => {
    const daysPassed = Math.floor((Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    return {
      ...order,
      daysPassed
    };
  });
}

// 取得模板
function getTemplate() {
  const data = readData();
  return data.template;
}

module.exports = {
  addPickupOrder,
  markAsPickedUp,
  deleteOrder,
  delayReminder,
  sendReminderNow,
  checkAndSendReminders,
  updateNote,
  updateTemplate,
  getAllOrders,
  getTemplate
};
