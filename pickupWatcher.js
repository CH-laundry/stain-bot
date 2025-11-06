// ======= pickupWatcher.js =======
// 🧼 C.H 精緻洗衣｜未取件測試提醒（Railway 版本）
// 模式：每 2 分鐘掃描一次，超過 10 分鐘未領取就通知（測試用）

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === 讀取環境變數 ===
const BASE_URL = process.env.AOLAN_API_BASE;
const TOKEN = process.env.AOLAN_AUTH_TOKEN;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TEST_USER = process.env.LINE_TEST_USER_ID;
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data";
const TRACK_FILE = path.join(VOLUME_PATH, "pickup-tracker.json");

const GRACE_MIN = Number(process.env.PICKUP_GRACE_MINUTES || 10);
const SCAN_MIN = Number(process.env.WATCH_SCAN_INTERVAL_MIN || 2);
const MAX_TIMES = Number(process.env.PICKUP_REMINDER_MAX_TIMES || 3);

console.log(`👀 取件監看中（每 ${SCAN_MIN} 分掃描）門檻：${GRACE_MIN} 分`);
console.log(`📁 資料檔：${TRACK_FILE}`);

// === 初始化追蹤檔 ===
if (!fs.existsSync(TRACK_FILE)) {
  fs.writeFileSync(TRACK_FILE, JSON.stringify({ items: [] }, null, 2));
}
let tracker = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));

// === 發 LINE 通知 ===
async function sendLineMsg(msg) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: TEST_USER,
      messages: [{ type: "text", text: msg }],
    }),
  });
  if (!res.ok) console.error("❌ LINE 發送失敗", await res.text());
}

// === 模擬掃描 ===
async function scan() {
  console.log("🔍 掃描中...");
  const now = Date.now();

  for (const item of tracker.items) {
    if (item.completed) continue;
    const minsPassed = (now - item.hungAt) / 60000;

    if (minsPassed >= GRACE_MIN && item.notifiedTimes < MAX_TIMES) {
      const msg = `🔔 測試通知：訂單 ${item.orderNo}（${item.receivingOrderId}）已超過 ${GRACE_MIN} 分未取件（測試通知）`;
      console.log("📨 發送通知：", msg);
      await sendLineMsg(msg);
      item.notifiedTimes++;
    }
  }

  fs.writeFileSync(TRACK_FILE, JSON.stringify(tracker, null, 2));
}

// === 週期執行 ===
setInterval(scan, SCAN_MIN * 60 * 1000);
scan(); // 立即執行一次

