// pickupWatcher.js - 取件提醒監控服務
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('@line/bot-sdk');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(DATA_DIR, 'pickup-tracker.json');

// 測試階段：10 分鐘
// 正式階段：改成 10080（7天）
const NOTIFY_THRESHOLD_MINUTES = 10;

// 你的 LINE ID（測試用）
const TEST_USER_ID = 'U5099169723d6e83588c5f23dfaf6f9cf';

// LINE Client
const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 讀取追蹤清單
function readTracker() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(TRACK_FILE)) {
      fs.writeFileSync(TRACK_FILE, JSON.stringify({ items: [] }, null, 2));
      return { items: [] };
    }
    return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
  } catch (e) {
    console.error('[ERROR] 讀取追蹤檔失敗：', e);
    return { items: [] };
  }
}

// 儲存追蹤清單
function writeTracker(tracker) {
  try {
    fs.writeFileSync(TRACK_FILE, JSON.stringify(tracker, null, 2));
  } catch (e) {
    console.error('[ERROR] 寫入追蹤檔失敗：', e);
  }
}

// 計算已過分鐘數
function minutesSince(dateString) {
  const date = new Date(dateString);
  return Math.floor((Date.now() - date.getTime()) / 60000);
}

// 主要監控邏輯
async function checkPickups() {
  console.log('[PICKUP_WATCHER] 開始檢查...');
  
  const tracker = readTracker();
  let notifiedCount = 0;

  for (const order of tracker.items) {
    const minutes = minutesSince(order.notifiedAt);
    
    // 跳過條件
    if (order.pickedUp) continue; // 已取件
    if (order.reminderSent) continue; // 已發過提醒
    if (minutes < NOTIFY_THRESHOLD_MINUTES) continue; // 未達門檻
    
    // 測試階段：只通知你的 ID
    if (order.userID !== TEST_USER_ID) continue;
    
    try {
      // 發送 LINE 提醒
      await lineClient.pushMessage(order.userID, {
        type: 'text',
        text: `🧼 【取件提醒】\n\n親愛的 ${order.customerName}，您的衣物已清洗完成超過 ${minutes} 分鐘，請盡快領取！\n\n訂單編號：${order.customerNumber}\n\nC.H 精緻洗衣 關心您 💙`
      });
      
      // 標記已發送
      order.reminderSent = true;
      order.reminderSentAt = new Date().toISOString();
      notifiedCount++;
      
      console.log(`[SUCCESS] 已發送提醒：${order.customerNumber} - ${order.customerName}`);
    } catch (error) {
      console.error(`[ERROR] 發送提醒失敗：${order.customerNumber}`, error);
    }
  }
  
  writeTracker(tracker);
  console.log(`[PICKUP_WATCHER] 檢查完成，發送 ${notifiedCount} 筆提醒`);
}

// 啟動監控
console.log('[PICKUP_WATCHER] 服務啟動');
console.log(`門檻：${NOTIFY_THRESHOLD_MINUTES} 分鐘`);
console.log(`測試 ID：${TEST_USER_ID}`);

// 立即執行一次
checkPickups();

// 每 2 分鐘檢查一次
setInterval(checkPickups, 2 * 60 * 1000);
