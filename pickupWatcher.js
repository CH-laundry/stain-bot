#!/usr/bin/env node
/**
 * pickupWatcher.js
 * 用途：定時掃描 /data/pickup-tracker.json
 *   1) 到 Aolan 查詢該 ReceivingOrder 是否「已簽收」
 *   2) 若超過門檻天數仍未簽收 → 自動再發一次提醒（Aolan 模板 & 可選 LINE Push）
 *   3) 直到查到簽收為止 → 標記 done，停止提醒但保留記錄
 *
 * 相依 API：
 *   - POST {AOLAN_BASE}/ReceivingOrder/SearchItemDetail
 *   - POST {AOLAN_BASE}/SendMessage/SendDeliverRemindTemplateMessage
 *   - POST https://api.line.me/v2/bot/message/push（若啟用）
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

// ===== 路徑與日誌 =====
const VOL_ROOT  = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(VOL_ROOT, 'pickup-tracker.json');
const LOG_FILE   = path.join(VOL_ROOT, 'pickup-watcher.log');

// 掃描頻率（分鐘）
const WATCH_SCAN_INTERVAL_MIN = parseInt(process.env.WATCH_SCAN_INTERVAL_MIN || '60', 10);

// ===== Aolan 設定（支援兩種命名）=====
const AOLAN_BASE_URL = process.env.AOLAN_BASE_URL || process.env.AOLAN_BASE || 'https://your-aolan.example.com';
const AOLAN_TOKEN    = process.env.AOLAN_TOKEN    || process.env.AOLAN_BEARER_TOKEN || '';

// ===== LINE Push（可選）=====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_PUSH_USERID_FIELD    = process.env.LINE_PUSH_USERID_FIELD    || 'LineUserId';
const LINE_TEST_USER_ID         = process.env.LINE_TEST_USER_ID         || '';

// ===== 工具：日誌 =====
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ===== 追蹤檔 I/O =====
function readTrack() {
  try { return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8')); }
  catch { return { items: [] }; }
}
function writeTrack(data) {
  try { fs.mkdirSync(path.dirname(TRACK_FILE), { recursive: true }); } catch {}
  const tmp = TRACK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TRACK_FILE);
}

// ===== Aolan：查詢訂單是否已簽收 =====
async function fetchOrderDetail(receivingOrderId) {
  const url = `${AOLAN_BASE_URL}/ReceivingOrder/SearchItemDetail`;
  const body = { ReceivingOrderID: String(receivingOrderId) };

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
    throw new Error(`SearchItemDetail 失敗 HTTP ${res.status} ${txt}`);
  }
  return await res.json().catch(() => ({}));
}

// ===== 是否簽收的穩健判斷 =====
// 優先：DeliverDate 有值 → 已簽收；其次：StatusName/FlowText 出現關鍵字
function isSigned(detail) {
  try {
    if (!detail || typeof detail !== 'object') return false;

    if (detail.DeliverDate) return true;

    const status = [
      detail.StatusName, detail.Status,
      detail.FlowText, detail.Flow
    ].filter(Boolean).join(' ').toLowerCase();

    // 可依你實際字樣再增修
    const keywords = ['已簽收', '已取件', 'picked up', 'signed', 'delivered', 'complete', 'completed'];
    return keywords.some(k => status.includes(k.toLowerCase()));
  } catch {
    return false;
  }
}

// ===== 從明細取 LINE 使用者 ID；若取不到就 fallback 到測試 ID =====
function extractLineUserId(detail) {
  try {
    const f = LINE_PUSH_USERID_FIELD;
    const id = (detail && detail[f]) ? String(detail[f]) : '';
    return id || LINE_TEST_USER_ID || '';
  } catch {
    return LINE_TEST_USER_ID || '';
  }
}

// ===== Aolan：發送逾期提醒模板 =====
async function sendOverdueReminder({ receivingOrderId, customerId, orderNo, isDelivery }) {
  const url = `${AOLAN_BASE_URL}/SendMessage/SendDeliverRemindTemplateMessage`;
  const body = {
    ReceivingOrderID: String(receivingOrderId),
    CustomerID: String(customerId),
    OrderNo: String(orderNo),
    IsDelivery: !!isDelivery,
    Overdue: true, // 若模板需辨識「逾期提醒」，可用此旗標
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
    throw new Error(`Aolan 逾期提醒失敗 HTTP ${res.status} ${txt}`);
  }
  return await res.json().catch(() => ({}));
}

// ===== LINE Push（可選）=====
async function linePushMessage(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) return { skipped: true };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LINE Push 失敗 HTTP ${res.status} ${txt}`);
  }
  return await res.json().catch(() => ({}));
}

// ===== 單次掃描 =====
async function scanOnce() {
  const track = readTrack();
  if (!track.items || !track.items.length) {
    log('🟦 目前無追蹤中的訂單。');
    return;
  }

  const now = Date.now();
  let changed = false;

  for (let i = 0; i < track.items.length; i++) {
    const t = track.items[i];
    if (t.status === 'done') continue;

    // 查詢最新明細
    let detail;
    try {
      detail = await fetchOrderDetail(t.receivingOrderId);
    } catch (e) {
      log(`❌ 查詢失敗 #${t.receivingOrderId}: ${e.message}`);
      continue;
    }

    // 已簽收 → 結案
    if (isSigned(detail)) {
      t.status = 'done';
      t.lastCheckedAt = now;
      t.notes = (t.notes || []).concat(`簽收結案@${new Date(now).toISOString()}`);
      changed = true;
      log(`✅ 已簽收，結案 #${t.receivingOrderId}（${t.orderNo}）`);
      continue;
    }

    // 未簽收 → 判斷是否跨過門檻
    const msFromStart   = now - (t.startedAt || now);
    const daysFromStart = msFromStart / (24 * 60 * 60 * 1000);
    t.lastCheckedAt = now;

    if (daysFromStart >= (t.graceDays || 7) && !t.remindSent) {
      try {
        // 1) Aolan 模板提醒
        await sendOverdueReminder({
          receivingOrderId: t.receivingOrderId,
          customerId: t.customerId,
          orderNo: t.orderNo,
          isDelivery: t.isDelivery,
        });

        // 2) LINE Push（若能取得 ID 或使用 fallback）
        const lineUserId = extractLineUserId(detail);
        if (lineUserId && LINE_CHANNEL_ACCESS_TOKEN) {
          const msg = `提醒您：訂單 ${t.orderNo} 已可取件，已超過門檻未簽收。如已完成，請忽略此訊息。感謝！`;
          await linePushMessage(lineUserId, msg);
        }

        t.lastNotifiedAt = now;
        t.remindSent = true;
        t.notes = (t.notes || []).concat(`已逾期提醒@${new Date(now).toISOString()}`);
        changed = true;
        log(`🔔 已發逾期提醒 #${t.receivingOrderId}（${t.orderNo}）`);
      } catch (e) {
        log(`❌ 逾期提醒失敗 #${t.receivingOrderId}: ${e.message}`);
      }
    } else {
      const pct = ((daysFromStart / (t.graceDays || 7)) * 100).toFixed(1);
      log(`⏳ 未簽收 #${t.receivingOrderId}（第 ${daysFromStart.toFixed(3)} 天 / 門檻 ${t.graceDays} 天，${pct}%）`);
    }
  }

  if (changed) writeTrack(track);
}

// ===== 入口點 =====
async function main() {
  log('🚀 pickupWatcher 啟動');
  log(`📄 追蹤檔：${TRACK_FILE}`);
  log(`🕒 掃描頻率：每 ${WATCH_SCAN_INTERVAL_MIN} 分鐘`);
  log(`🌐 Aolan：${AOLAN_BASE_URL}`);

  // 立即掃一次
  try { await scanOnce(); } catch (e) { log('首次掃描異常：', e.message); }

  // 之後週期掃描
  setInterval(() => {
    scanOnce().catch(e => log('掃描異常：', e.message));
  }, WATCH_SCAN_INTERVAL_MIN * 60 * 1000);
}

main().catch(err => {
  log('程式異常：', err.message);
  process.exit(1);
});
