#!/usr/bin/env node
/**
 * startPickupTrack.js
 * 用途：發送首次「取衣通知」，並把訂單加入追蹤清單（/data/pickup-tracker.json）
 * 用法：
 *   node startPickupTrack.js <ReceivingOrderID> <CustomerID> <OrderNo> <isDelivery 0|1>
 *   例：
 *     店內自取：node startPickupTrack.js 12345 CUST001 A12345678 0
 *     外送訂單：node startPickupTrack.js 67890 CUST999 B87654321 1
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// 若你使用 Node 18+ 可用全域 fetch；否則採用 node-fetch
let fetchFn = global.fetch;
if (typeof fetchFn !== 'function') {
  fetchFn = require('node-fetch');
}
const fetch = (...args) => fetchFn(...args);

// ===== 路徑與持久化 =====
const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(VOL_ROOT, 'pickup-tracker.json');

// ===== 門檻設定：分鐘優先、未設分鐘則退回天數 =====
const PICKUP_GRACE_MINUTES   = parseInt(process.env.PICKUP_GRACE_MINUTES   || '0', 10);
const DELIVERY_GRACE_MINUTES = parseInt(process.env.DELIVERY_GRACE_MINUTES || '0', 10);
const PICKUP_GRACE_DAYS      = parseInt(process.env.PICKUP_GRACE_DAYS      || '7', 10);
const DELIVERY_GRACE_DAYS    = parseInt(process.env.DELIVERY_GRACE_DAYS    || '3', 10);

// ===== Aolan API：同時支援你原本與我原先的命名 =====
const AOLAN_BASE_URL = process.env.AOLAN_BASE_URL || process.env.AOLAN_BASE || 'https://your-aolan.example.com';
const AOLAN_TOKEN    = process.env.AOLAN_TOKEN    || process.env.AOLAN_BEARER_TOKEN || '';

// ===== 工具：追蹤檔 I/O =====
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function readTrack() {
  try {
    return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8'));
  } catch {
    return { items: [] };
  }
}
function writeTrack(data) {
  ensureDir(path.dirname(TRACK_FILE));
  const tmp = TRACK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TRACK_FILE);
}

// ===== 首次「取衣通知」：Aolan 模板訊息 =====
// 依你實際 API 規格調整 body 欄位
async function sendInitialPickupNotice({ receivingOrderId, customerId, orderNo, isDelivery }) {
  const url = `${AOLAN_BASE_URL}/SendMessage/SendDeliverRemindTemplateMessage`;
  const body = {
    ReceivingOrderID: String(receivingOrderId),
    CustomerID: String(customerId),
    OrderNo: String(orderNo),
    IsDelivery: !!isDelivery,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AOLAN_TOKEN ? { Authorization: `Bearer ${AOLAN_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Aolan 首次通知失敗 HTTP ${res.status} ${txt}`);
  }
  return await res.json().catch(() => ({}));
}

// ===== 主程式 =====
(async () => {
  const [,, receivingOrderId, customerId, orderNo, isDeliveryRaw] = process.argv;

  if (!receivingOrderId || !customerId || !orderNo || typeof isDeliveryRaw === 'undefined') {
    console.error('❌ 參數錯誤：用法：node startPickupTrack.js <ReceivingOrderID> <CustomerID> <OrderNo> <isDelivery 0|1>');
    process.exit(1);
  }

  const isDelivery = String(isDeliveryRaw) === '1';

  // 送首次通知（失敗仍會加入追蹤，避免漏追）
  try {
    const r = await sendInitialPickupNotice({ receivingOrderId, customerId, orderNo, isDelivery });
    console.log('✅ 已發送首次取衣通知：', r);
  } catch (e) {
    console.error('⚠️ 首次通知失敗，但仍加入追蹤：', e.message);
  }

  const track = readTrack();

  const foundIdx = track.items.findIndex(x => String(x.receivingOrderId) === String(receivingOrderId));
  const now = Date.now();

  // 依 isDelivery 取對應門檻
  const graceMinutes = isDelivery ? DELIVERY_GRACE_MINUTES : PICKUP_GRACE_MINUTES;
  const graceDays    = isDelivery ? DELIVERY_GRACE_DAYS    : PICKUP_GRACE_DAYS;

  // 分鐘優先；若有設定分鐘 → 換算為「天」的小數
  const effectiveGraceDays = (graceMinutes > 0)
    ? (graceMinutes / (24 * 60))
    : graceDays;

  const entry = {
    receivingOrderId: String(receivingOrderId),
    customerId: String(customerId),
    orderNo: String(orderNo),
    isDelivery: !!isDelivery,
    startedAt: foundIdx >= 0 ? track.items[foundIdx].startedAt : now,
    graceDays: effectiveGraceDays,          // watcher 以天數比較，支援小數（例如 10 分鐘 ≈ 0.00694 天）
    status: 'tracking',                     // tracking | done
    lastCheckedAt: 0,
    lastNotifiedAt: 0,                      // 逾期提醒觸發時間
    remindSent: false,                      // 僅在跨門檻第一次提醒
    notes: [],
  };

  if (foundIdx >= 0) {
    const old = track.items[foundIdx];
    track.items[foundIdx] = { ...old, ...entry, startedAt: old.startedAt };
  } else {
    track.items.push(entry);
  }

  writeTrack(track);
  console.log(`💾 已加入追蹤：#${entry.receivingOrderId}（${entry.isDelivery ? '外送' : '店取'}，門檻=${entry.graceDays} 天）`);
  console.log(`📄 追蹤檔：${TRACK_FILE}`);
})().catch(err => {
  console.error('程式異常：', err);
  process.exit(1);
});
