/**
 * pickupWatcher.js
 * 功能：
 *  - 每隔 WATCH_SCAN_INTERVAL_MIN 分鐘掃描追蹤清單（/data 或 ./data）
 *  - 若已簽收 → 結案（不再提醒）
 *  - 若超過門檻（例如 10 分鐘/7 天）且尚未提醒 → 呼叫 Aolan 模板 & 直接推 LINE 給你自己
 *
 * 只新增了「推 LINE」能力，不更動你原有邏輯與其他檔案。
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// === 新增：LINE 推播用 ===
const { Client } = require('@line/bot-sdk');

// ---------- 儲存路徑設定（Railway Volume 優先） ----------
const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const FALLBACK_ROOT = path.join(__dirname, 'data');
const STORE_DIR = fs.existsSync(VOL_ROOT) ? VOL_ROOT : FALLBACK_ROOT;
const TRACK_FILE = path.join(STORE_DIR, 'pickup-tracker.json');

// ---------- 環境變數 ----------
const BASE = process.env.AOLAN_BASE || '';
const TOKEN = process.env.AOLAN_BEARER_TOKEN || '';
const INTERVAL_MIN = toInt(process.env.WATCH_SCAN_INTERVAL_MIN, 1); // 每幾分鐘掃描一次（測試 1 分鐘）
const MAX_TIMES = toInt(process.env.PICKUP_REMINDER_MAX_TIMES, 1);  // 逾期最多提醒次數（預設 1 次）

// === LINE 推播設定（推給你自己的帳號以利測試） ===
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SELF_ID = process.env.LINE_TEST_USER_ID || '';
const lineClient = LINE_TOKEN ? new Client({ channelAccessToken: LINE_TOKEN }) : null;

// ---------- 工具：讀/寫 JSON ----------
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

// ---------- 工具：型別/字串 ----------
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

// ---------- LINE 推播（推給你自己的帳號做驗證） ----------
async function pushLine(text) {
  if (!lineClient || !LINE_SELF_ID) {
    console.log('ℹ️ 未設定 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_TEST_USER_ID，略過 LINE 推播');
    return;
  }
  try {
    await lineClient.pushMessage(LINE_SELF_ID, { type: 'text', text });
    console.log('✅ 已推播 LINE 訊息給測試帳號');
  } catch (e) {
    console.error('❌ LINE 推播失敗：', e.message);
  }
}

// ---------- 查詢是否已簽收 ----------
// 依你的環境：/ReceivingOrder/SearchItemDetail 為 POST + JSON Body：{ ReceivingOrderID }
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
      // 保守處理：查詢失敗視為未簽收，避免錯過提醒
      return false;
    }

    const j = await res.json().catch(() => ({}));
    // 兼容多種欄位：DeliverDate/DeliveredAt/SignOffAt 有值，或狀態字含「簽收/已取/已領/完成」
    const deliverDate = getFirst(j, ['DeliverDate', 'DeliveredAt', 'SignOffAt']);
    if (deliverDate) return true;

    const statusText = [
      getFirst(j, ['StatusTypeName']),
      getFirst(j, ['StatusName']),
      getFirst(j, ['FlowText']),
      getFirst(j, ['FlowName'])
    ].filter(Boolean).join(' | ');
    const signedLike = /(簽收|已取|已領|完成|closed|done)/i;
    return signedLike.test(String(statusText));
  } catch (err) {
    console.error('⚠️ 查詢簽收狀態異常：', err.message);
    return false;
  }
}

// ---------- 發送逾期提醒（Aolan 模板 + 同步推 LINE） ----------
async function sendOverdue(order) {
  // 1) 嘗試呼叫 Aolan 模板（就算 500 也不影響我們推 LINE）
  const url = joinUrl(BASE, '/SendMessage/SendDeliverRemindTemplateMessage');
  const body = {
    ReceivingOrderID: order.receivingOrderId,
    CustomerID: order.customerId,
    OrderNo: order.orderNo,
    IsDelivery: !!order.isDelivery
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
  } catch (err) {
    console.error('❌ 逾期提醒呼叫異常（Aolan）：', err.message);
  }

  // 2) 一定會推一則 LINE 訊息到你的測試帳號（確保你看得到）
  await pushLine(`💌 溫馨提醒,：您的衣物已清潔好了,怕您忘記,方便時間可以來領取喔 謝謝您 💙`);
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

      // 1) 是否已簽收
      const signed = await isSigned(o.receivingOrderId);
      if (signed) {
        o.completed = true;
        changed = true;
        console.log(`✅ 已簽收，結案 #${o.receivingOrderId}（${o.orderNo}）`);
        continue;
      }

      // 2) 未簽收 → 檢查是否已逾期
      const remainMs = (o.deadlineAt || 0) - now;
      if (remainMs <= 0) {
        const times = toInt(o.notifiedTimes, 0);
        if (times < MAX_TIMES) {
          await sendOverdue(o);
          o.notifiedTimes = times + 1;
          o.lastNotifiedAt = now;
          changed = true;
        } else {
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

// ---------- 啟動 ----------
const SCAN_MS = Math.max(1, INTERVAL_MIN) * 60 * 1000;
console.log(`👀 取件監看中：每 ${INTERVAL_MIN} 分鐘掃描一次。資料檔：${TRACK_FILE}`);
setInterval(tick, SCAN_MS);
tick();
