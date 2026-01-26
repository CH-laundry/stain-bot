/**
 * startPickupTrack.js
 * 功能：在「衣物全部上掛完成」後觸發通知，並開始 7 天追蹤計時
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const trackerFile = path.join(__dirname, 'data/pickup-tracker.json');
if (!fs.existsSync(path.dirname(trackerFile))) fs.mkdirSync(path.dirname(trackerFile), { recursive: true });

// === 主程式 ===
(async () => {
  const [,, receivingOrderId, customerId, orderNo, isDeliveryFlag] = process.argv;
  const isDelivery = String(isDeliveryFlag) === '1';
  if (!receivingOrderId || !customerId || !orderNo) {
    console.error('❌ 缺少參數：node startPickupTrack.js <ReceivingOrderID> <CustomerID> <OrderNo> <IsDelivery(0或1)>');
    process.exit(1);
  }

  console.log(`🚀 開始追蹤：OrderNo=${orderNo} | ReceivingOrderID=${receivingOrderId} | 店取/外送=${isDelivery ? '外送' : '店取'}`);

  // === 1️⃣ 先抓「上掛完成時間」 ===
  const base = process.env.AOLAN_BASE?.replace(/\/+$/, '') || '';
  const token = process.env.AOLAN_BEARER_TOKEN || '';
  const detailUrl = `${base}/ReceivingOrder/SearchItemDetail`;

  let startedAt = Date.now();
  try {
    const res = await fetch(detailUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ReceivingOrderID: String(receivingOrderId) })
    });
    const data = await res.json().catch(() => ({}));

    // 優先找出時間欄位（可能不同伺服器命名）
    const timeField = data.DoneAt || data.AllHungAt || data.OnHangerAt || data.FinishDate || data.CleanFinishAt;
    if (timeField) {
      const parsed = Date.parse(timeField);
      if (Number.isFinite(parsed)) {
        startedAt = parsed;
        console.log(`📅 已抓到上掛完成時間：${new Date(parsed).toLocaleString()}`);
      } else {
        console.log('⚠️ Aolan 回傳的時間格式無法解析，改用現在時間。');
      }
    } else {
      console.log('⚠️ Aolan 未提供上掛完成時間，改用現在時間。');
    }
  } catch (err) {
    console.log('⚠️ 無法取得上掛完成時間，改用現在時間：', err.message);
  }

  // === 2️⃣ 計算 7 天門檻 ===
  const graceDays = Number(process.env.PICKUP_GRACE_DAYS || 7);
  const deadlineAt = startedAt + graceDays * 24 * 60 * 60 * 1000;

  // === 3️⃣ 呼叫 Aolan 的發送通知 ===
  const remindUrl = `${base}/SendMessage/SendDeliverRemindTemplateMessage`;
  try {
    const res = await fetch(remindUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ReceivingOrderID: receivingOrderId,
        CustomerID: customerId,
        OrderNo: orderNo,
        IsDelivery: isDelivery
      })
    });
    const text = await res.text();
    console.log(`📨 首次通知 成功：${res.status} ${res.statusText} - ${text}`);
  } catch (err) {
    console.error('❌ 首次通知發送失敗：', err.message);
  }

  // === 4️⃣ 寫入追蹤檔 ===
  let tracker = { items: [] };
  if (fs.existsSync(trackerFile)) {
    tracker = JSON.parse(fs.readFileSync(trackerFile, 'utf8'));
  }
  if (!Array.isArray(tracker.items)) tracker.items = [];

  tracker.items.push({
    receivingOrderId,
    customerId,
    orderNo,
    isDelivery,
    startedAt,
    deadlineAt,
    completed: false,
    notifiedTimes: 0
  });

  fs.writeFileSync(trackerFile, JSON.stringify(tracker, null, 2));
  console.log(`💾 已加入追蹤：#${receivingOrderId}（門檻 ${graceDays} 天；存檔：${trackerFile}）`);
})();
