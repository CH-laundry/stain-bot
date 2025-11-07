// pickupWatcher.js — 強化 Log／自我檢查版
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Client } = require('@line/bot-sdk');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(DATA_DIR, 'pickup-tracker.json');

const NOTIFY_MIN = parseInt(process.env.PICKUP_NOTIFY_MINUTES || '10', 10);
const REPEAT_MIN = parseInt(process.env.PICKUP_REPEAT_MINUTES || '120', 10);
const POLL_SEC   = parseInt(process.env.PICKUP_POLL_INTERVAL_SEC || '60', 10);

const ORDER_URL_TPL = process.env.ORDER_DETAIL_URL || '';

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const PICKUP_API_URL   = process.env.PICKUP_API_URL || '';
const PICKUP_API_TOKEN = process.env.PICKUP_API_TOKEN || '';

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

function fatalIfMissing(name, val) {
  if (!val) {
    console.error(`[FATAL] 缺少必要環境變數：${name}`);
    process.exit(1);
  }
}
fatalIfMissing('ADMIN_USER_ID', ADMIN_USER_ID);
fatalIfMissing('PICKUP_API_URL', PICKUP_API_URL);

function readTracker() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TRACK_FILE)) {
      fs.writeFileSync(TRACK_FILE, JSON.stringify({ items: {} }, null, 2));
      return { items: {} };
    }
    return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
  } catch (e) {
    console.error('[WARN] 讀取追蹤檔失敗，重置。', e);
    return { items: {} };
  }
}
function writeTracker(tracker) {
  try { fs.writeFileSync(TRACK_FILE, JSON.stringify(tracker, null, 2)); }
  catch (e) { console.error('[ERROR] 寫入追蹤檔失敗：', e); }
}
function normalizeItem(item) {
  const orderId = item.orderId || item.id || item.order_no || item.orderNo || String(item._id || '');
  const hangRaw = item.hangerTime || item.hangTime || item.onHookAt || item.hook_time || item.hookTime;
  const hangTs  = hangRaw ? new Date(hangRaw) : null;
  const picked  = !!item.pickedUp || !!item.picked ||
                  (item.status && String(item.status).toLowerCase().includes('picked')) ||
                  !!item.pickedUpAt;
  const lineUserId = item.lineUserId || item.userId || (item.customer && item.customer.lineId) || null;
  return { orderId, hangTs, picked, lineUserId };
}
function minutesSince(date) {
  if (!date) return Infinity;
  return Math.floor((Date.now() - date.getTime()) / 60000);
}
function buildOrderUrl(orderId) {
  return ORDER_URL_TPL ? ORDER_URL_TPL.replace('{orderId}', encodeURIComponent(orderId)) : null;
}
async function fetchHangedOrders() {
  const headers = { 'Content-Type': 'application/json' };
  if (PICKUP_API_TOKEN) headers['Authorization'] = `Bearer ${PICKUP_API_TOKEN}`;
  const t0 = Date.now();
  const res = await fetch(PICKUP_API_URL, { headers, timeout: 20000 }).catch(e => { throw e; });
  const latency = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('API 回傳非 Array');
  console.log(`[API] ${PICKUP_API_URL} OK (${latency}ms) 回 ${data.length} 筆`);
  return data.map(normalizeItem).filter(x => x.orderId);
}
async function pushToAdmin(text) {
  try { await lineClient.pushMessage(ADMIN_USER_ID, [{ type: 'text', text }]); }
  catch (e) { console.error('[ERROR] 推播給 ADMIN 失敗：', e); }
}

let isRunning = false;
async function tick() {
  if (isRunning) return;
  isRunning = true;
  const tStart = Date.now();
  const tracker = readTracker();
  tracker.items ||= {};
  try {
    const list = await fetchHangedOrders();
    let notified = 0;

    for (const it of list) {
      const { orderId, hangTs, picked } = it;
      if (!orderId || !hangTs) continue;

      if (picked) { if (tracker.items[orderId]) { delete tracker.items[orderId]; console.log(`[CLEAN] ${orderId} 已取件`); } continue; }

      const hangMin = minutesSince(hangTs);
      const rec = tracker.items[orderId] || { lastNotifiedAt: 0, firstSeenAt: Date.now() };

      if (hangMin < NOTIFY_MIN) { tracker.items[orderId] = rec; continue; }

      const last = rec.lastNotifiedAt || 0;
      const passedMin = Math.floor((Date.now() - last) / 60000);
      if (last && passedMin < (parseInt(process.env.PICKUP_REPEAT_MINUTES || '120', 10))) continue;

      const url = buildOrderUrl(orderId);
      const text = [
        `【取件提醒（測試）】訂單 ${orderId}`,
        `已上掛超過 ${NOTIFY_MIN} 分鐘。`,
        url ? `👉 查看：${url}` : `（可設定 ORDER_DETAIL_URL 附上連結）`,
      ].join('\n');
      await pushToAdmin(text);

      rec.lastNotifiedAt = Date.now();
      tracker.items[orderId] = rec;
      notified++;
    }

    console.log(`[TICK] 完成。通知 ${notified} 筆；耗時 ${Date.now()-tStart}ms`);
  } catch (e) {
    console.error(`[ERROR] tick 失敗：${e.message}`);
  } finally {
    writeTracker(tracker);
    isRunning = false;
  }
}

console.log(`[BOOT] pickupWatcher 已啟動。門檻=${NOTIFY_MIN} 分鐘；重複=${process.env.PICKUP_REPEAT_MINUTES||120} 分鐘；輪詢=${POLL_SEC}s`);
console.log(`[BOOT] Volume 目錄：${DATA_DIR}；追蹤檔：${TRACK_FILE}`);
tick();
setInterval(tick, POLL_SEC * 1000);

// 可選：上線後要確認推播是否暢通，設 ADMIN_PING=1 會在啟動時給你發一則測試訊息
if (process.env.ADMIN_PING === '1') {
  pushToAdmin('✅ 取件監看器已啟動（自動訊息）');
}
