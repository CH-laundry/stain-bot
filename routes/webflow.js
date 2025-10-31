// routes/webflow.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const { Client } = require('@line/bot-sdk');
const customerDB = require('../services/customerDatabase');
const logger = require('../services/logger');
const orderManager = require('../services/orderManager');

const { createECPayPaymentLink } = require('../services/openai'); // 綠界
// createLinePayPayment 存在於你的 index.js，目前這裡直接 require index 會重複啟動伺服器。
// 因此我們在本檔內「複製一個輕量呼叫器」，轉呼叫你現有的全域函式（見下方 globalThis 再掛）。
let callCreateLinePayPayment = null;

const router = express.Router();

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ========== 1) 儲存用戶 ==========
router.post('/api/register-user', async (req, res) => {
  try {
    const { userId, displayName = '' } = req.body || {};
    if (!userId) return res.status(400).json({ error: '缺少 userId' });

    await customerDB.saveCustomer(userId, displayName || '');
    logger.logToFile(`✅ register-user: ${userId} (${displayName})`);
    res.json({ success: true });
  } catch (e) {
    logger.logError('register-user 失敗', e);
    res.status(500).json({ error: e.message });
  }
});

// ========== 2) 發送支付連結（ecpay / linepay / both） ==========
router.post('/api/send-paylink', async (req, res) => {
  try {
    const { userId, userName = '貴賓', amount, payment = 'ecpay', customMessage } = req.body || {};
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return res.status(400).json({ error: '金額不正確' });

    const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
    if (!baseURL) logger.logToFile('⚠️ 未設定 RAILWAY_PUBLIC_DOMAIN/RAILWAY_STATIC_URL');

    let ecpayLink = null, linepayLink = null;
    let ecpayOrderId = '', linePayOrderId = '';
    const groupId = `G${Date.now()}${Math.random().toString(36).slice(2,7).toUpperCase()}`; // 關聯群組ID（兩連結綁一起）

    // --- 綠界 ---
    if (payment === 'ecpay' || payment === 'both') {
      ecpayOrderId = `EC${Date.now()}${Math.random().toString(36).slice(2,7).toUpperCase()}`;
      orderManager.createOrder(ecpayOrderId, { userId, userName, amount: numAmount, groupId, channel: 'ecpay', status: 'PENDING' });
      logger.logToFile(`✅ 建立綠界訂單: ${ecpayOrderId}`);

      // 走你原本的綠界生成器（它會回一個 redirect 連結）
      const link = createECPayPaymentLink(userId, userName, numAmount);
      // 包一層「持久入口」，以便到期可重生新頁（你 index.js 已採用這個模式）
      let persistent = `${baseURL}/payment/ecpay/pay/${ecpayOrderId}`;
      ecpayLink = persistent;

      // 短網址（可選）
      try {
        const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistent)}`);
        const t = await r.text();
        if (t && t.startsWith('http')) ecpayLink = t;
      } catch {}
    }

    // --- LINE Pay ---
    if (payment === 'linepay' || payment === 'both') {
      if (typeof callCreateLinePayPayment !== 'function') {
        return res.status(500).json({ error: 'LINE Pay 初始化中，稍後再試' });
      }
      const lp = await callCreateLinePayPayment(userId, userName, numAmount);
      if (lp?.success) {
        linePayOrderId = lp.orderId;
        orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount, groupId, channel: 'linepay', status: 'PENDING',
          linepayTransactionId: lp.transactionId, linepayPaymentUrl: lp.paymentUrl });
        logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linePayOrderId}`);

        let persistent = `${baseURL}/payment/linepay/pay/${linePayOrderId}`;
        linepayLink = persistent;

        try {
          const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(persistent)}`);
          const t = await r.text();
          if (t && t.startsWith('http')) linepayLink = t;
        } catch {}
      } else {
        logger.logToFile(`❌ LINE Pay 建立失敗: ${lp?.error || 'unknown'}`);
      }
    }

    // 組裝訊息
    let finalMessage = '';
    const userPrefix = customMessage ? `${customMessage}\n\n` : `您好，${userName} 👋\n\n您的專屬付款連結已生成\n金額：NT$ ${numAmount.toLocaleString()}\n\n`;
    if (payment === 'both' && ecpayLink && linepayLink) {
      finalMessage = `${userPrefix}請選擇付款方式：\n\n【信用卡（綠界）】\n${ecpayLink}\n\n【LINE Pay】\n${linepayLink}\n\n✅ 付款後系統會自動通知我們，感謝您的支持 💙`;
    } else if (payment === 'ecpay' && ecpayLink) {
      finalMessage = `${userPrefix}【信用卡（綠界）】\n${ecpayLink}\n\n✅ 付款後系統會自動通知我們，感謝您的支持 💙`;
    } else if (payment === 'linepay' && linepayLink) {
      finalMessage = `${userPrefix}【LINE Pay】\n${linepayLink}\n\n✅ 付款後系統會自動通知我們，感謝您的支持 💙`;
    } else {
      return res.status(500).json({ error: '支付連結生成失敗' });
    }

    // 推播給客人
    await client.pushMessage(userId, { type: 'text', text: finalMessage });

    const summary =
      payment === 'both'
        ? `已送出兩種連結（group: ${groupId}）`
        : `已送出 ${payment === 'ecpay' ? '綠界' : 'LINE Pay'} 連結`;

    res.json({ success: true, summary, groupId, ecpayOrderId, linePayOrderId });
  } catch (e) {
    logger.logError('send-paylink 失敗', e);
    res.status(500).json({ error: e.message });
  }
});

// ======= 共用：任一付款成功後，關聯訂單停止提醒 =======
function markSiblingsPaidAndStopReminders(paidOrder) {
  try {
    const ORDERS_FILE = path.join('/data', 'orders.json'); // 與 orderManager 同路徑習慣
    if (!fs.existsSync(ORDERS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8') || '[]');
    const now = Date.now();

    // 同 user、同金額、7天內建立、且非自己、且仍為待付
    const siblings = arr.filter(o =>
      o && o.orderId !== paidOrder.orderId &&
      o.userId === paidOrder.userId &&
      Number(o.amount) === Number(paidOrder.amount) &&
      (now - (o.createdAt || now)) <= 7 * 24 * 60 * 60 * 1000 &&
      (o.status || 'PENDING') !== 'PAID'
    );

    // 把兄弟訂單標記為由另一連結完成，並設置停止提醒旗標
    siblings.forEach(o => {
      o.status = 'PAID_BY_OTHER';
      o.stopReminders = true;
      o.paidGroup = paidOrder.groupId || paidOrder.orderId;
      o.updatedAt = now;
    });

    fs.writeFileSync(ORDERS_FILE, JSON.stringify(arr, null, 2));
    logger.logToFile(`🔕 關聯訂單已停止提醒：${siblings.map(s=>s.orderId).join(', ') || '(無)'}`);
  } catch (err) {
    logger.logError('標記兄弟訂單停止提醒失敗', err);
  }
}

// 讓 index.js 在啟動時把 createLinePayPayment 掛進來（見下方說明）
function setLinePayInvoker(fn) { callCreateLinePayPayment = fn; }
module.exports = { router, setLinePayInvoker, markSiblingsPaidAndStopReminders };
