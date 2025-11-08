// pickupWatcher.js
const pickupCustomerDB = require('./services/pickupCustomerDB');
const client = require('./lineClient');
const fs = require('fs');
const path = require('path');

// 測試模式：改成 7 天 = 20 分鐘
const TEST_MODE = false; // 改成 false 就是正式模式
const CHECK_INTERVAL = TEST_MODE ? 2 * 60 * 1000 : 60 * 60 * 1000; // 測試：2分鐘，正式：1小時
const REMINDER_DAYS = TEST_MODE ? (20 / 60 / 24) : 7; // 測試：20分鐘，正式：7天

// 載入提醒模板
function loadReminderTemplate() {
  const templatePath = path.join(__dirname, 'data', 'pickup-template.json');
  try {
    if (fs.existsSync(templatePath)) {
      const data = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      return data.template || '親愛的 {客戶姓名}，您的衣物已清洗完成超過 {已過天數} 天，請盡快來領取！訂單編號：{客戶編號}';
    }
  } catch (error) {
    console.error('[PICKUP] 載入模板失敗:', error.message);
  }
  return '親愛的 {客戶姓名}，您的衣物已清洗完成超過 {已過天數} 天，請盡快來領取！訂單編號：{客戶編號}';
}

// 替換模板變數
function fillTemplate(template, data) {
  return template
    .replace(/{客戶姓名}/g, data.customerName || '')
    .replace(/{客戶編號}/g, data.customerNumber || '')
    .replace(/{已過天數}/g, data.daysPassed || 0);
}

// 發送提醒訊息
async function sendReminder(order) {
  try {
    const daysPassed = Math.floor((Date.now() - new Date(order.notifiedAt).getTime()) / (1000 * 60 * 60 * 24));
    
    // 載入模板
    const template = loadReminderTemplate();
    const message = fillTemplate(template, {
      customerName: order.customerName,
      customerNumber: order.customerNumber,
      daysPassed: daysPassed
    });

    // 發送 LINE 訊息
    await client.pushMessage(order.userID, {
      type: 'text',
      text: message
    });

    // 記錄發送
    const reminderLog = {
      sentAt: new Date().toISOString(),
      message: message,
      daysPassed: daysPassed
    };

    // 更新資料庫
    pickupCustomerDB.updateOrder(order.customerNumber, {
      reminderSent: true,
      reminderCount: (order.reminderCount || 0) + 1,
      lastReminderAt: new Date().toISOString(),
      reminderHistory: [...(order.reminderHistory || []), reminderLog]
    });

    console.log(`[PICKUP] ✅ 已發送提醒給 ${order.customerName} (${order.customerNumber})`);
    return true;
  } catch (error) {
    console.error(`[PICKUP] ❌ 發送提醒失敗:`, error.message);
    return false;
  }
}

// 檢查並發送提醒
async function checkAndSendReminders() {
  const orders = pickupCustomerDB.getAllOrders();
  
  if (orders.length === 0) {
    console.log('[PICKUP] 沒有需要追蹤的訂單');
    return;
  }

  const now = Date.now();
  let sentCount = 0;

  for (const order of orders) {
    // 跳過已取件的
    if (order.pickedUp) continue;

    const notifiedTime = new Date(order.notifiedAt).getTime();
    const daysPassed = (now - notifiedTime) / (1000 * 60 * 60 * 24);

    // 每 7 天提醒一次
    const reminderCount = order.reminderCount || 0;
    const nextReminderDay = (reminderCount + 1) * REMINDER_DAYS;

    if (daysPassed >= nextReminderDay) {
      console.log(`[PICKUP] 🔔 客戶 ${order.customerName} 已過 ${Math.floor(daysPassed)} 天，發送提醒...`);
      const success = await sendReminder(order);
      if (success) sentCount++;
    }
  }

  if (sentCount > 0) {
    console.log(`[PICKUP] ✅ 本次發送 ${sentCount} 則提醒`);
  }
}

// 啟動監控
function startWatcher() {
  console.log(`[PICKUP] 取件追蹤監控啟動 - ${TEST_MODE ? '測試模式 (20 分鐘)' : '正式模式 (7 天)'}`);
  console.log(`[PICKUP] ${TEST_MODE ? '測試模式：每 2 分鐘檢查一次' : '正式模式：每 1 小時檢查一次'}`);

  // 立即執行一次
  checkAndSendReminders();

  // 定時執行
  setInterval(checkAndSendReminders, CHECK_INTERVAL);
}

module.exports = {
  startWatcher,
  sendReminder,
  loadReminderTemplate
};
