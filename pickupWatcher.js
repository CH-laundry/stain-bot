#!/usr/bin/env node
/**
 * pickupWatcher.js
 * 功能：定時掃描 /data/pickup-tracker.json
 *   1) 到 Aolan 查詢該 ReceivingOrder 是否「已簽收」
 *   2) 若超過門檻天數仍未簽收 → 自動再發一次提醒（Aolan 模板 & 可選 LINE Push）
 *   3) 直到查到簽收為止 → 標記 done，停止提醒但仍保留記錄
 *
 * 你已確認可用的 API：
 *   - ReceivingOrder/SearchItemDetail（判斷是否已簽收）
 *   - SendMessage/SendDeliverRemindTemplateMessage（逾期提醒模板消息）
 *   - LINE Push（可選）
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// === 環境設定 ===
const VOL_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const TRACK_FILE = path.join(VOL_ROOT, 'pickup-tracker.json');
const LOG_FILE = path.join(VOL_ROOT, 'pickup-watcher.log');

const WATCH_SCAN_INTERVAL_MIN = parseInt(process.env.WATCH_SCAN_INTERVAL_MIN || '60', 10); // 預設每 60 分掃描

// Aolan
const AOLAN_BASE_URL = process.env.AOLAN_BASE_URL || 'https://your-aolan.example.com';
const AOLAN_TOKEN = process.env.AOLAN_TOKEN || '';

// LINE（可選：若你希望同時 Push LINE 訊息）
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_PUSH_USERID_FIELD = process.env.LINE_PUSH_USERID_FIELD || 'LineUserId'; // 假設 SearchItemDetail 或你們 mapping 會提供

// === 工具：日誌 ===
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// === 工具：讀寫追蹤檔 ===
function readTrack() {
  try {
    return JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8'));
  } catch {
    return { items: [] };
  }
}
function writeTrack(data) {
  try {
    fs.mkdirSync(path.dirname(TRACK_FILE), { recursive: true });
  } catch {}
  const tmp = TRACK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TRACK_FILE);
}

// === Aolan：查詢訂單是否已簽收 ===
// 依你的 API 輸入調整 body 或 query；下方示例為 POST JSON
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

  const json = await res.json().catch(() => ({}));
  return json;
}

// 盡量穩健的「是否簽收」判斷（可依實際欄位微調）
// 優先序：DeliverDate 有值 → 已簽收；或 StatusName/FlowText 出現「已簽收」字樣
function isSigned(detail) {
  try {
    const d = detail || {};
    if (d.DeliverDate) return true;
    const status = `${d.StatusName || ''}${d.Status || ''}`; // 有些系統用 Status / StatusName
    const flow = `${d.FlowText || ''}${d.Flow || ''}`;
    const hay = (status + ' ' + flow).toLowerCase();
    return hay.includes('已簽收') || hay.includes('signed') || hay.includes('delivered');
  } catch {
    return false;
  }
}

// 取出可用的 LINE UserId（若有）
function extractLineUserId(detail) {
  try {
    const f = LINE_PUSH_USERID_FIELD;
    return detail && detail[f] ? String(detail[f]) : '';
  } catch {
    return '';
  }
}

// === Aolan：發送逾期提醒模板 ===
async function sendOverdueReminder({ receivingOrderId, customerId, orderNo, isDelivery }) {
  const url = `${AOLAN_BASE_URL}/SendMessage/SendDeliverRemindTemplateMessage`;
  const body = {
    ReceivingOrderID: String(receivingOrderId),
    CustomerID: String(customerId),
    OrderNo: String(orderNo),
    IsDelivery: !!isDelivery,
    Overdue: true, // 若你模板需知道是「逾期提醒」，可放旗標
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

  const json = await res.json().catch(() => ({}));
  return json;
}

// === LINE Push（可選）===
async function linePushMessage(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) return { skipped: true };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LINE Push 失敗 HTTP ${res.status} ${txt}`);
  }
  return await res.json().catch(() => ({}));
}

// === 主循環 ===
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
    if (t.status === 'done') continue; // 已結案

    // 查詢訂單明細
    let detail;
    try {
      detail = await fetchOrderDetail(t.receivingOrderId);
    } catch (e) {
      log(`❌ 查詢失敗 #${t.receivingOrderId}:`, e.message);
      continue; // 下回再查
    }

    // 是否已簽收
    if (isSigned(detail)) {
      t.status = 'done';
      t.lastCheckedAt = now;
      t.notes = (t.notes || []).concat(`簽收結案@${new Date(now).toISOString()}`);
      changed = true;
      log(`✅ 已簽收，結案 #${t.receivingOrderId}（${t.orderNo}）`);
      continue;
    }

    // 未簽收 → 判斷是否跨過門檻天數
    const msFromStart = now - (t.startedAt || now);
    const daysFromStart = Math.floor(msFromStart / (24 * 60 * 60 * 1000));
    t.lastCheckedAt = now;

    // 只在首次跨過門檻時計一次提醒
    if (daysFromStart >= (t.graceDays || 7) && !t.remindSent) {
      try {
        // 1) Aolan 模板提醒
        await sendOverdueReminder({
          receivingOrderId: t.receivingOrderId,
          customerId: t.customerId,
          orderNo: t.orderNo,
          isDelivery: t.isDelivery,
        });

        // 2) LINE Push（若取得到 LineUserId 且你有 Access Token）
        const lineUserId = extractLineUserId(detail);
        if (lineUserId && LINE_CHANNEL_ACCESS_TOKEN) {
          const msg = `提醒您：訂單 ${t.orderNo} 已可取件，已超過 ${t.graceDays} 天未簽收。如已完成，請忽略此訊息。感謝！`;
          await linePushMessage(lineUserId, msg);
        }

        t.lastNotifiedAt = now;
        t.remindSent = true;
        t.notes = (t.notes || []).concat(`已逾期提醒@${new Date(now).toISOString()}`);
        changed = true;
        log(`🔔 已發逾期提醒 #${t.receivingOrderId}（${t.orderNo}）`);
      } catch (e) {
        log(`❌ 逾期提醒失敗 #${t.receivingOrderId}:`, e.message);
      }
    } else {
      log(`⏳ 未簽收 #${t.receivingOrderId}（第 ${daysFromStart} 天 / 門檻 ${t.graceDays} 天）`);
    }
  }

  if (changed) writeTrack(track);
}

async function main() {
  log('🚀 pickupWatcher 啟動中…');
  log(`📄 追蹤檔：${TRACK_FILE}`);
  log(`🕒 掃描頻率：每 ${WATCH_SCAN_INTERVAL_MIN} 分鐘`);

  // 立即掃描一次
  await scanOnce().catch(e => log('首次掃描異常：', e.message));

  // 之後週期掃描
  setInterval(() => {
    scanOnce().catch(e => log('掃描異常：', e.message));
  }, WATCH_SCAN_INTERVAL_MIN * 60 * 1000);
}

main().catch(err => {
  log('程式異常：', err.message);
  process.exit(1);
});
