// pickupWatcher.js - 取件自動通知（正式測試用）
// 不影響原有功能，可獨立部署運行

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const dayjs = require("dayjs");
const { Client } = require("@line/bot-sdk");

// === 環境設定 ===
const DATA_FILE = path.join("/data/stain-bot", "pickup-tracker.json");
const CHECK_INTERVAL_MINUTES = 10; // ✅ 每10分鐘檢查
const AOLAN_BASE = process.env.AOLAN_API_BASE; // 例：https://hk2.ao-lan.cn/xiyi-yidianyuan1
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "U5099169723d6e83588c5f23dfaf6f9cf"; // ✅ 測試你自己
const LINE_CLIENT = new Client({ channelAccessToken: LINE_TOKEN, channelSecret: LINE_SECRET });

// === 初始化資料檔 ===
if (!fs.existsSync("/data/stain-bot")) fs.mkdirSync("/data/stain-bot", { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

// === 讀取追蹤清單 ===
function loadList() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveList(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// === 抓洗統巴詳細資料 ===
async function fetchAolanDetail(receivingOrderId) {
  try {
    const url = `${AOLAN_BASE}/ReceivingOrder/SearchItemDetail?receivingOrderId=${encodeURIComponent(receivingOrderId)}`;
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.log("[Aolan] 回傳非 JSON：", text);
      return null;
    }
    const hangAt =
      data?.Data?.HangingCompletedAt ||
      data?.Data?.OnHangerTime ||
      data?.Data?.HangDoneAt ||
      data?.Data?.上掛完成時間 ||
      null;
    const signed = data?.Data?.IsSigned || data?.Data?.Collected || false;
    return { hangAt, signed };
  } catch (err) {
    console.log("⚠️ Aolan 查詢失敗：", err.message);
    return null;
  }
}

// === 推播通知 ===
async function notifyLine(msg) {
  try {
    await LINE_CLIENT.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
    console.log("✅ 已推播 LINE 通知");
  } catch (err) {
    console.error("❌ LINE 通知失敗:", err.message);
  }
}

// === 主要檢查邏輯 ===
async function checkPickupStatus() {
  console.log(`[${dayjs().format("YYYY/MM/DD HH:mm:ss")}] 🔍 開始掃描...`);
  const list = loadList();
  if (!list.length) return console.log("（目前無追蹤資料）");

  for (const item of list) {
    const { receivingOrderId, orderNo } = item;
    const r = await fetchAolanDetail(receivingOrderId);
    if (!r) continue;

    if (r.signed) {
      console.log(`✅ 已簽收：${orderNo}`);
      item.completed = true;
      continue;
    }

    if (!r.hangAt) {
      console.log(`⏸️ 尚未上掛完成：${orderNo}`);
      continue;
    }

    const diff = dayjs().diff(dayjs(r.hangAt), "minute");
    if (diff >= CHECK_INTERVAL_MINUTES && !item.notified) {
      const msg = `🔔【正式測試通知】\n單號：${orderNo}\n上掛時間：${dayjs(r.hangAt).format(
        "MM/DD HH:mm"
      )}\n已經超過 ${diff} 分鐘未取件。`;
      await notifyLine(msg);
      item.notified = true;
      console.log(`📩 已通知：${orderNo}`);
    }
  }
  saveList(list);
}

// === 自動排程 ===
setInterval(checkPickupStatus, CHECK_INTERVAL_MINUTES * 60 * 1000);
console.log(`👀 取件監看已啟動（每 ${CHECK_INTERVAL_MINUTES} 分鐘掃描一次）`);

// === 啟動時立刻執行一次 ===
checkPickupStatus();
