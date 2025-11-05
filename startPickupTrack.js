#!/usr/bin/env node
/**
 * startPickupTrack.js
 * 功能：發送首次「取衣通知」，並把訂單加入追蹤清單（/data/pickup-tracker.json）
 * 用法：
 *   node startPickupTrack.js <ReceivingOrderID> <CustomerID> <OrderNo> <isDelivery>
 *   例：
 *     店內自取：node startPickupTrack.js 12345 CUST001 A12345678 0
 *     外送訂單：node startPickupTrack.js 67890 CUST999 B87654321 1
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(VOL_ROOT, 'pickup-tracker.json');

// 天數門檻（可由 .env 覆蓋）
const PICKUP_GRACE_DAYS = parseInt(process.env.PICKUP_GRACE_DAYS || '7', 10);   // 店取
const DELIVERY_GRACE_DAYS = parseInt(process.env.DELIVERY_GRACE_DAYS || '3', 10); // 外送

// Aolan API（請依你環境補齊）
const AOLAN_BASE_URL = process.env.AOLAN_BASE_URL || 'https://your-aolan.example.com';
const AOLAN_TOKEN = process.env.AOLAN_TOKEN || ''; // Bearer / Key 依你系統調整

// === 工具：讀寫追蹤檔 ===
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

// === Aolan：發送首次「取衣通知」 ===
// 你已確認可用的 API：SendMessage/SendDeliverRemindTemplateMessage
// 請依你的參數格式調整 body（這裡給出通用欄位，保留擴充位）
async function sendInitialPickupNotice({ receivingOrderId, customerId, orderNo, isDelivery }) {
  const url = `${AOLAN_BASE_URL}/SendMessage/SendDeliverRemindTemplateMessage`;
  const body = {
    // ↓↓↓ 視你實際 API 規格調整 ↓↓↓
    ReceivingOrderID: String(receivingOrderId),
    CustomerID: String(customerId),
    OrderNo: String(orderNo),
    IsDelivery: !!isDelivery,
    // 可加入你們固定模板需要的欄位，例如門市名、取件時間等
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

  const json = await res.json().catch(() => ({}));
  return json;
}

// === 主程式 ===
(async () => {
  const [,, receivingOrderId, customerId, orderNo, isDeliveryRaw] = process.argv;

  if (!receivingOrderId || !customerId || !orderNo || typeof isDeliveryRaw === 'undefined') {
    console.error('❌ 參數錯誤：');
    console.error('   用法：node startPickupTrack.js <ReceivingOrderID> <CustomerID> <OrderNo> <isDelivery 0|1>');
    process.exit(1);
  }

  const isDelivery = String(isDeliveryRaw) === '1';

  // 先送出首次通知
  try {
    const r = await sendInitialPickupNotice({ receivingOrderId, customerId, orderNo, isDelivery });
    console.log('✅ 已發送首次取衣通知：', r);
  } catch (e) {
    console.error('❌ 首次通知失敗：', e.message);
    // 若首次通知失敗，你仍可選擇加入追蹤或中止。這裡採「仍加入追蹤」以免漏追。
  }

  // 寫入/更新追蹤檔
  const track = readTrack();

  // 若此 ReceivingOrderID 已存在，維持最早的 startedAt（避免誤改起算點）
  const foundIdx = track.items.findIndex(x => String(x.receivingOrderId) === String(receivingOrderId));
  const now = Date.now();
  const graceDays = isDelivery ? DELIVERY_GRACE_DAYS : PICKUP_GRACE_DAYS;

  const entry = {
    receivingOrderId: String(receivingOrderId),
    customerId: String(customerId),
    orderNo: String(orderNo),
    isDelivery: !!isDelivery,
    startedAt: foundIdx >= 0 ? track.items[foundIdx].startedAt : now,
    graceDays,
    status: 'tracking',        // tracking | done
    lastCheckedAt: 0,
    lastNotifiedAt: 0,         // 逾期提醒（只在跨過門檻時觸發一次）
    remindSent: false,
    notes: [],
  };

  if (foundIdx >= 0) {
    // 更新可能變動的欄位（例如是否被標記為外送、訂單號異動等）
    const old = track.items[foundIdx];
    const merged = { ...old, ...entry, startedAt: old.startedAt };
    track.items[foundIdx] = merged;
  } else {
    track.items.push(entry);
  }

  writeTrack(track);
  console.log(`💾 已加入追蹤：#${receivingOrderId}（${isDelivery ? '外送' : '店取'}，門檻 ${graceDays} 天）`);
  console.log(`📄 檔案：${TRACK_FILE}`);
})().catch(err => {
  console.error('程式異常：', err);
  process.exit(1);
});
