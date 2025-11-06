// ======= pickupWatcher.js =======
// 🧼 C.H 精緻洗衣｜未取件提醒 Watcher（Railway 常駐版）
// 特色：不改動原有功能、可由 index.js 啟動、部署即跑、免本機指令

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// 允許本機或 Railway 讀 .env（Railway 會用 Variables，這段不影響）
try { require('dotenv').config(); } catch (e) {}

// === 環境變數 ===
const AOLAN_BASE = process.env.AOLAN_API_BASE || process.env.AOLAN_BASE || 'https://hk2.ao-lan.cn/xiyi-yidianyuan1';
const AOLAN_TOKEN = process.env.AOLAN_AUTH_TOKEN || process.env.AOLAN_BEARER_TOKEN || '';
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const TEST_USER   = process.env.LINE_TEST_USER_ID || process.env.LINE_USER_ID || '';

// 門檻與排程
const GRACE_MIN   = Number(process.env.PICKUP_GRACE_MINUTES || 10);     // 測試用：10 分鐘
const SCAN_MIN    = Number(process.env.WATCH_SCAN_INTERVAL_MIN || 2);   // 每 2 分鐘掃一次（測試）
const MAX_TIMES   = Number(process.env.PICKUP_REMINDER_MAX_TIMES || 3); // 最多提醒次數

// 資料存放（Railway Volume）
const VOL_DIR     = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE  = path.join(VOL_DIR, 'pickup-tracker.json');

// 測試自動種一筆（部署即跑、免手動）
const SEED_ROID   = process.env.TRACK_TEST_RECEIVING_ORDER_ID || '';    // be8011...
const SEED_CID    = process.env.TRACK_TEST_CUSTOMER_ID || '';           // 437b...
const SEED_ORDER  = process.env.TRACK_TEST_ORDER_NO || '';              // CH-TEST-XXX
const SEED_IS_DEL = (process.env.TRACK_TEST_IS_DELIVERY || '0') === '1';

function ensureDataFile() {
  if (!fs.existsSync(VOL_DIR)) {
    try { fs.mkdirSync(VOL_DIR, { recursive: true }); } catch (e) {}
  }
  if (!fs.existsSync(TRACK_FILE)) {
    fs.writeFileSync(TRACK_FILE, JSON.stringify({ items: [] }, null, 2));
  }
}

function loadTracker() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
  } catch {
    return { items: [] };
  }
}

function saveTracker(j) {
  fs.writeFileSync(TRACK_FILE, JSON.stringify(j, null, 2));
}

async function sendLine(toUserId, text) {
  if (!LINE_TOKEN || !toUserId) return;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: toUserId, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) {
    const body = await res.text().catch(()=> '');
    console.error('❌ LINE 推播失敗：', res.status, body);
  }
}

// Aolan 範本訊息（測試階段失敗不影響整體）
async function sendAolanTemplateRemind(receivingOrderId) {
  if (!AOLAN_TOKEN) return;
  try {
    const url = `${AOLAN_BASE}/SendMessage/SendDeliverRemindTemplateMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AOLAN_TOKEN}` },
      body: JSON.stringify({ ReceivingOrderID: receivingOrderId })
    });
    const body = await res.text().catch(()=> '');
    console.log(`🔔 逾期提醒(Aolan) 回應：${res.status} ${res.statusText} - ${body.slice(0, 200)}...`);
  } catch (e) {
    console.warn('⚠️ 逾期提醒呼叫異常（Aolan）：', e.message);
  }
}

// 新增追蹤（供內部與 startPickupTrack.js 使用）
function addTrack({ receivingOrderId, customerId, orderNo, isDelivery, hungAt }) {
  const db = loadTracker();
  const exists = db.items.find(x => x.receivingOrderId === receivingOrderId);
  if (exists) return false;

  const now = Date.now();
  db.items.push({
    receivingOrderId,
    customerId,
    orderNo,
    isDelivery: !!isDelivery,
    hungAt: typeof hungAt === 'number' ? hungAt : now, // 若無上掛時間，先用現在
    notifiedTimes: 0,
    completed: false
  });
  saveTracker(db);
  console.log(`💾 已加入追蹤：#${receivingOrderId}（門檻 ${GRACE_MIN} 分；存檔：${TRACK_FILE}）`);
  return true;
}

// 若設定了 SEED_*，部署就自動種一筆測試
function maybeSeedOne() {
  if (!SEED_ROID || !SEED_ORDER) return;
  const ok = addTrack({
    receivingOrderId: SEED_ROID,
    customerId: SEED_CID || 'TEST-CID',
    orderNo: SEED_ORDER,
    isDelivery: SEED_IS_DEL,
    hungAt: Date.now()
  });
  if (ok) {
    console.log(`🌱 已自動加入測試追蹤：${SEED_ORDER} (${SEED_ROID})`);
  }
}

// 掃描邏輯
async function scanOnce() {
  const db = loadTracker();
  const now = Date.now();

  for (const item of db.items) {
    if (item.completed) continue;

    const minsPassed = (now - item.hungAt) / 60000;
    const over = minsPassed >= GRACE_MIN;

    if (over && item.notifiedTimes < MAX_TIMES) {
      // 測試：先推到你的 LINE ID
      const msg = `🔔 測試通知｜訂單 ${item.orderNo}（${item.receivingOrderId}）已超過 ${GRACE_MIN} 分未取件`;
      await sendLine(TEST_USER, msg);

      // 同步嘗試 Aolan 範本（不阻塞、不影響）
      sendAolanTemplateRemind(item.receivingOrderId).catch(()=>{});

      item.notifiedTimes += 1;
      console.log(`✅ 已推播(第 ${item.notifiedTimes}/${MAX_TIMES} 次)：${item.orderNo}`);
    }
  }
  saveTracker(db);
}

let _timer = null;
function start() {
  ensureDataFile();
  console.log(`👀 取件監看已啟動：每 ${SCAN_MIN} 分掃描一次；門檻 ${GRACE_MIN} 分；資料檔：${TRACK_FILE}`);
  maybeSeedOne();
  // 立即掃一次 + 設定排程
  scanOnce().catch(e => console.error('scanOnce error:', e));
  _timer = setInterval(() => scanOnce().catch(e => console.error('scanOnce error:', e)), SCAN_MIN * 60 * 1000);
}

function status() {
  const j = loadTracker();
  return { items: j.items, graceMin: GRACE_MIN, scanMin: SCAN_MIN, file: TRACK_FILE };
}

module.exports = { start, status, addTrack };
