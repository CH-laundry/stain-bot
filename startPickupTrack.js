/**
 * startPickupTrack.js
 * 功能：發送「可取件通知」，並把訂單加入追蹤清單（10 分鐘/7 天等由 .env 控制）
 * ✅ 不修改現有任何檔案；資料存到 /data/pickup-tracker.json（或本機 ./data/）
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ---------- 路徑設定：優先寫 Railway Volume ----------
const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const FALLBACK_ROOT = path.join(__dirname, 'data');
const STORE_DIR = fs.existsSync(VOL_ROOT) ? VOL_ROOT : FALLBACK_ROOT;
const TRACK_FILE = path.join(STORE_DIR, 'pickup-tracker.json');

// ---------- 參數與環境 ----------
const BASE = process.env.AOLAN_BASE || '';
const TOKEN = process.env.AOLAN_BEARER_TOKEN || '';
const GRACE_MIN = toInt(process.env.PICKUP_GRACE_MINUTES, null);
const GRACE_DAYS = toInt(process.env.PICKUP_GRACE_DAYS, 7); // 正式預設 7 天
const NOW = Date.now();

const args = process.argv.slice(2);
const [receivingOrderId, customerId, orderNo, isDeliveryFlag] = args;

if (!receivingOrderId || !customerId || !orderNo || typeof isDeliveryFlag === 'undefined') {
  console.error('❌ 用法：npm run pickup:track -- <ReceivingOrderID> <CustomerID> <OrderNo> <isDelivery(0/1)>');
  process.exit(1);
}

const isDelivery = String(isDeliveryFlag) === '1';
const graceMs = GRACE_MIN != null
  ? (GRACE_MIN * 60 * 1000)
  : (GRACE_DAYS * 24 * 60 * 60 * 1000);
const deadline = NOW + graceMs;

ensureDir(STORE_DIR);

// ---------- 發送首次可取件通知（Aolan 模板） ----------
async function sendFirstMessage() {
  const url = joinUrl(BASE, '/SendMessage/SendDeliverRemindTemplateMessage');
  const body = {
    ReceivingOrderID: receivingOrderId,
    CustomerID: customerId,
    OrderNo: orderNo,
    IsDelivery: !!isDelivery
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const ok = res.ok;
    const text = await safeText(res);
    console.log(`📨 首次通知 ${ok ? '成功' : '失敗'}：${res.status} ${res.statusText} ${text ? '- ' + trunc(text) : ''}`);
  } catch (err) {
    console.error('⚠️ 首次通知呼叫異常：', err.message);
  }
}

// ---------- 寫入追蹤檔 ----------
function addToTracker() {
  const state = loadJson(TRACK_FILE, { items: [] });
  const exists = state.items.find(x => String(x.receivingOrderId) === String(receivingOrderId));
  const rec = {
    receivingOrderId,
    customerId,
    orderNo,
    isDelivery,
    startedAt: NOW,
    deadlineAt: deadline,
    completed: false,
    notifiedTimes: 0,
    lastNotifiedAt: null
  };

  if (exists) {
    // 若已存在就更新門檻時間與基本欄位（避免重複）
    Object.assign(exists, rec);
  } else {
    state.items.push(rec);
  }

  saveJson(TRACK_FILE, state);
  const mins = (graceMs / 60000).toFixed(2);
  console.log(`💾 已加入追蹤：#${receivingOrderId}（門檻 ${mins} 分鐘；存檔：${TRACK_FILE}）`);
}

// ---------- Main ----------
(async () => {
  console.log(`🚀 開始追蹤：OrderNo=${orderNo} | ReceivingOrderID=${receivingOrderId} | 店取/外送=${isDelivery ? '外送' : '店取'}`);
  await sendFirstMessage();
  addToTracker();
  process.exit(0);
})();

// ---------- 小工具 ----------
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function loadJson(file, def) {
  try {
    if (!fs.existsSync(file)) return def;
    const s = fs.readFileSync(file, 'utf8').trim();
    return s ? JSON.parse(s) : def;
  } catch { return def; }
}
function saveJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {}
}
function toInt(val, def) {
  if (val == null) return def;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}
function joinUrl(base, p) {
  if (!base) return p;
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
function trunc(s, n = 200) {
  return String(s).length > n ? String(s).slice(0, n) + '…' : s;
}
