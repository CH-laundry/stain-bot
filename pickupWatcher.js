/**
 * pickupWatcher.js
 * 功能：每隔 WATCH_SCAN_INTERVAL_MIN 分鐘檢查追蹤清單：
 *   - 若已簽收 → 結案
 *   - 若超過門檻且尚未通知 → 發送逾期提醒（Aolan 模板）
 * ✅ 不修改現有任何檔案；資料存到 /data/pickup-tracker.json（或本機 ./data/）
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ---------- 路徑設定 ----------
const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const FALLBACK_ROOT = path.join(__dirname, 'data');
const STORE_DIR = fs.existsSync(VOL_ROOT) ? VOL_ROOT : FALLBACK_ROOT;
const TRACK_FILE = path.join(STORE_DIR, 'pickup-tracker.json');

// ---------- 環境 ----------
const BASE = process.env.AOLAN_BASE || '';
const TOKEN = process.env.AOLAN_BEARER_TOKEN || '';
const INTERVAL_MIN = toInt(process.env.WATCH_SCAN_INTERVAL_MIN, 1);
const MAX_TIMES = toInt(process.env.PICKUP_REMINDER_MAX_TIMES, 1); // 預設逾期提醒 1 次
const SCAN_MS = Math.max(1, INTERVAL_MIN) * 60 * 1000;

// ---------- 檢查是否簽收 ----------
// 依你先前提供：SearchItemDetail = POST + JSON Body：{ReceivingOrderID: "..."}
async function isSigned(receivingOrderId) {
  const url = joinUrl(BASE, '/ReceivingOrder/SearchItemDetail');
  const body = { ReceivingOrderID: String(receivingOrderId) };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const t = await safeText(res);
      console.warn(`⚠️ SearchItemDetail 非 2xx：${res.status} ${res.statusText} ${t ? '- ' + trunc(t) : ''}`);
      // 失敗時保守判斷：先視為「未簽收」，避免錯過提醒
      return false;
    }

    const j = await res.json().catch(() => ({}));
    // 兼容多種欄位：DeliverDate 有值、或狀態文字含「簽收/已取件/完成」等
    const deliverDate = getFirst(j, ['DeliverDate', 'DeliveredAt', 'SignOffAt']);
    const statusText = [
      getFirst(j, ['StatusTypeName']),
      getFirst(j, ['StatusName']),
      getFirst(j, ['FlowText']),
      getFirst(j, ['FlowName'])
    ].filter(Boolean).join(' | ');

    if (deliverDate) return true;

    const signedLike = /(簽收|已取|已領|完成|closed|done)/i;
    return signedLike.test(String(statusText));
  } catch (err) {
    console.error('⚠️ 查詢簽收狀態異常：', err.message);
    return false;
  }
}

// ---------- 發送逾期提醒（Aolan 模板，同一路徑即可） ----------
async function sendOverdue(order) {
  const url = joinUrl(BASE, '/SendMessage/SendDeliverRemindTemplateMessage');
  const body = {
    ReceivingOrderID: order.receivingOrderId,
    CustomerID: order.customerId,
    OrderNo: order.orderNo,
    IsDelivery: !!order.isDelivery
    // 許多客製 API 也接受 Overdue: true，但既已測過同一路徑可用，就不加自訂欄位避免風險
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
    console.log(`🔔 逾期提醒 ${ok ? '成功' : '失敗'}：#${order.receivingOrderId}（${order.orderNo}） ${res.status} ${res.statusText} ${text ? '- ' + trunc(text) : ''}`);
    return ok;
  } catch (err) {
    console.error('❌ 逾期提醒呼叫異常：', err.message);
    return false;
  }
}

// ---------- 主迴圈 ----------
function tick() {
  const state = loadJson(TRACK_FILE, { items: [] });
  if (!Array.isArray(state.items) || state.items.length === 0) {
    console.log('📁 目前沒有追蹤中的訂單。檔案：' + TRACK_FILE);
    return;
  }

  const now = Date.now();
  let changed = false;

  (async () => {
    for (const o of state.items) {
      if (o.completed) continue;

      // 1) 判斷是否已簽收
      const signed = await isSigned(o.receivingOrderId);
      if (signed) {
        o.completed = true;
        changed = true;
        console.log(`✅ 已簽收，結案 #${o.receivingOrderId}（${o.orderNo}）`);
        continue;
      }

      // 2) 未簽收，檢查是否已逾期
      const remainMs = (o.deadlineAt || 0) - now;
      if (remainMs <= 0) {
        const times = toInt(o.notifiedTimes, 0);

        if (times < MAX_TIMES) {
          const ok = await sendOverdue(o);
          o.notifiedTimes = times + (ok ? 1 : 0);
          o.lastNotifiedAt = now;
          changed = true;
        } else {
          // 已達最大提醒次數，不再提醒，但持續列在追蹤（直到簽收）
          console.log(`⏰ 已達最大提醒次數（${MAX_TIMES}）#${o.receivingOrderId}（${o.orderNo}）`);
        }
      } else {
        const minsPassed = ((now - (o.startedAt || now)) / 60000).toFixed(2);
        const minsLeft = (remainMs / 60000).toFixed(2);
        console.log(`⏳ 未簽收 #${o.receivingOrderId}（${o.orderNo}）｜已過 ${minsPassed} 分｜剩餘 ${minsLeft} 分`);
      }
    }

    if (changed) saveJson(TRACK_FILE, state);
  })().catch(e => console.error('tick error:', e.message));
}

console.log(`👀 取件監看中：每 ${INTERVAL_MIN} 分鐘掃描一次。資料檔：${TRACK_FILE}`);
setInterval(tick, SCAN_MS);
tick();

// ---------- 小工具 ----------
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
function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function joinUrl(base, p) {
  if (!base) return p;
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
function getFirst(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v != null && v !== '') return v;
  }
  return null;
}
function trunc(s, n = 200) {
  return String(s).length > n ? String(s).slice(0, n) + '…' : s;
}
