// pickupWatcher.js
// 取件追蹤背景監控服務

const fs = require('fs');
const { Client } = require('@line/bot-sdk');
const logger = require('./services/logger');

// LINE Client
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const PICKUP_TRACKER_FILE = '/data/pickup-tracker.json';
const REMINDER_TEMPLATES_FILE = '/data/reminder-templates.json';

// ========== 設定 ==========
const CONFIG = {
  // 測試模式：20 分鐘
  TEST_MODE: true,
  TEST_THRESHOLD_MS: 20 * 60 * 1000, // 20 分鐘
  
  // 正式模式：7 天，中午 12:00
  PRODUCTION_THRESHOLD_DAYS: 7,
  PRODUCTION_REMINDER_HOUR: 12, // 中午 12 點
  
  // 測試用的 User ID（你的編號 625）
  TEST_USER_ID: process.env.TEST_USER_ID || 'U5099169723d6e83588c5f23dfaf6f9cf'
};

// 確保檔案存在
function ensureFiles() {
  const dir = '/data';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  if (!fs.existsSync(PICKUP_TRACKER_FILE)) {
    fs.writeFileSync(PICKUP_TRACKER_FILE, JSON.stringify({ items: [] }, null, 2));
  }
  
  if (!fs.existsSync(REMINDER_TEMPLATES_FILE)) {
    const defaultTemplate = '親愛的 {客戶姓名}，您的衣物已清洗完成超過 {已過天數} 天，請盡快來領取！訂單編號：{客戶編號}';
    fs.writeFileSync(REMINDER_TEMPLATES_FILE, JSON.stringify({ templates: [defaultTemplate] }, null, 2));
  }
}

// 讀取追蹤清單
function readTracker() {
  ensureFiles();
  try {
    const data = fs.readFileSync(PICKUP_TRACKER_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.logError('讀取追蹤清單失敗', error);
    return { items: [] };
  }
}

// 寫入追蹤清單
function writeTracker(tracker) {
  try {
    fs.writeFileSync(PICKUP_TRACKER_FILE, JSON.stringify(tracker, null, 2));
  } catch (error) {
    logger.logError('寫入追蹤清單失敗', error);
  }
}

// 讀取提醒模板
function readTemplates() {
  ensureFiles();
  try {
    const data = fs.readFileSync(REMINDER_TEMPLATES_FILE, 'utf8');
    const templates = JSON.parse(data);
    return templates.templates || [];
  } catch (error) {
    return ['親愛的 {客戶姓名}，您的衣物已清洗完成超過 {已過天數} 天，請盡快來領取！訂單編號：{客戶編號}'];
  }
}

// 替換模板變數
function formatMessage(template, data) {
  const daysPassed = Math.floor((Date.now() - new Date(data.notifiedAt).getTime()) / (1000 * 60 * 60 * 24));
  const hoursPassed = Math.floor((Date.now() - new Date(data.notifiedAt).getTime()) / (1000 * 60 * 60));
  
  return template
    .replace(/{客戶姓名}/g, data.customerName || '-')
    .replace(/{客戶編號}/g, data.customerNumber || '-')
    .replace(/{通知日期}/g, new Date(data.notifiedAt).toLocaleDateString('zh-TW'))
    .replace(/{已過天數}/g, daysPassed)
    .replace(/{已過時數}/g, hoursPassed);
}

// 檢查是否需要提醒
function shouldSendReminder(order) {
  if (order.pickedUp) return false;
  if (!order.userID) return false;

  const now = Date.now();
  const notifiedTime = new Date(order.notifiedAt).getTime();
  const elapsed = now - notifiedTime;

  if (CONFIG.TEST_MODE) {
    // 測試模式：超過 20 分鐘就提醒
    const lastReminder = order.lastReminderAt ? new Date(order.lastReminderAt).getTime() : 0;
    const timeSinceLastReminder = now - lastReminder;
    
    // 如果從未提醒過，且已超過 20 分鐘
    if (!order.reminderSent && elapsed >= CONFIG.TEST_THRESHOLD_MS) {
      return true;
    }
    
    // 如果已提醒過，每 20 分鐘再提醒一次
    if (order.reminderSent && timeSinceLastReminder >= CONFIG.TEST_THRESHOLD_MS) {
      return true;
    }
    
    return false;
  } else {
    // 正式模式：7 天後的中午 12:00 提醒
    const days = Math.floor(elapsed / (1000 * 60 * 60 * 24));
    
    if (days < CONFIG.PRODUCTION_THRESHOLD_DAYS) return false;
    
    // 計算應該提醒的次數（每 7 天一次）
    const expectedReminders = Math.floor(days / CONFIG.PRODUCTION_THRESHOLD_DAYS);
    const actualReminders = order.reminderCount || 0;
    
    if (actualReminders >= expectedReminders) return false;
    
    // 檢查現在是否是中午 12 點
    const currentHour = new Date().getHours();
    if (currentHour !== CONFIG.PRODUCTION_REMINDER_HOUR) return false;
    
    // 檢查今天是否已經提醒過
    if (order.lastReminderAt) {
      const lastReminderDate = new Date(order.lastReminderAt).toDateString();
      const today = new Date().toDateString();
      if (lastReminderDate === today) return false;
    }
    
    return true;
  }
}

// 發送提醒
async function sendReminder(order) {
  try {
    const templates = readTemplates();
    const template = templates[0] || '親愛的 {客戶姓名}，您的衣物已清洗完成，請盡快來領取！';
    const message = formatMessage(template, order);
    
    await client.pushMessage(order.userID, {
      type: 'text',
      text: message
    });
    
    logger.logToFile(`[PICKUP] 已發送提醒：${order.customerNumber} - ${order.customerName}`);
    return true;
  } catch (error) {
    logger.logError('發送提醒失敗', error);
    return false;
  }
}

// 主要檢查函數
async function checkAndSendReminders() {
  const tracker = readTracker();
  
  if (!tracker.items || tracker.items.length === 0) {
    logger.logToFile('[PICKUP] 沒有需要追蹤的訂單');
    return;
  }
  
  let sent = 0;
  
  for (const order of tracker.items) {
    if (shouldSendReminder(order)) {
      const success = await sendReminder(order);
      
      if (success) {
        order.reminderSent = true;
        order.lastReminderAt = new Date().toISOString();
        order.reminderCount = (order.reminderCount || 0) + 1;
        sent++;
      }
    }
  }
  
  if (sent > 0) {
    writeTracker(tracker);
    logger.logToFile(`[PICKUP] 本次檢查完成，發送了 ${sent} 筆提醒`);
  }
}

// 啟動監控
function startWatcher() {
  ensureFiles();
  
  const mode = CONFIG.TEST_MODE ? '測試模式 (20 分鐘)' : '正式模式 (7 天中午)';
  logger.logToFile(`[PICKUP] 取件追蹤監控啟動 - ${mode}`);
  
  // 立即執行一次
  checkAndSendReminders().catch(error => {
    logger.logError('初次檢查失敗', error);
  });
  
  // 定時執行
  if (CONFIG.TEST_MODE) {
    // 測試模式：每 2 分鐘檢查一次
    setInterval(() => {
      checkAndSendReminders().catch(error => {
        logger.logError('定時檢查失敗', error);
      });
    }, 2 * 60 * 1000);
    logger.logToFile('[PICKUP] 測試模式：每 2 分鐘檢查一次');
  } else {
    // 正式模式：每小時檢查一次（只在中午 12 點執行）
    setInterval(() => {
      checkAndSendReminders().catch(error => {
        logger.logError('定時檢查失敗', error);
      });
    }, 60 * 60 * 1000);
    logger.logToFile('[PICKUP] 正式模式：每小時檢查，中午 12:00 發送');
  }
}

module.exports = {
  startWatcher,
  checkAndSendReminders
};
