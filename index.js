// ============== 引入依賴 ==============
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
require('dotenv').config();

const { Client } = require('@line/bot-sdk');
const orderManager = require('./services/orderManager');
const logger = require('./services/logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== LINE 初始化 ==============
const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// ============== 靜態檔案 ==============
app.use(express.static('public'));

// ============== 健康檢查 ==============
app.get('/health', (_req, res) => res.send('OK'));

// ============== 付款頁路由 ==============
app.get('/payment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});
app.get('/', (req, res) => res.redirect('/payment'));

// ============== 客戶資料存檔 ==============
const CUSTOMER_FILE = path.join(__dirname, './data/customers.json');
function saveCustomerData(data) {
  try {
    let customers = [];
    if (fs.existsSync(CUSTOMER_FILE)) {
      customers = JSON.parse(fs.readFileSync(CUSTOMER_FILE, 'utf8'));
    }
    const index = customers.findIndex(c => c.userId === data.userId);
    if (index >= 0) customers[index] = data;
    else customers.push(data);
    fs.writeFileSync(CUSTOMER_FILE, JSON.stringify(customers, null, 2));
    logger.logToFile(`✅ 儲存客戶資料：${data.userName}`);
    return true;
  } catch (err) {
    logger.logError('儲存客戶資料失敗', err);
    return false;
  }
}

// ============== 發送付款連結（POST） ==============
app.post('/api/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, paymentMethod } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ error: '缺少參數' });
    }

    // 建立訂單
    const orderId = 'ORD' + Date.now();
    const order = orderManager.createOrder(orderId, {
      userId,
      userName,
      amount,
    });

    // 模擬綠界付款連結（永久）
    const ecpayUrl = `${process.env.BASE_URL}/payment/redirect?order=${orderId}`;
    orderManager.updatePaymentInfo(orderId, `TXN${Date.now()}`, ecpayUrl);

    // 模擬 LINE Pay 永久入口（點進去才會生成官方20分鐘連結）
    const linePayPermanent = `${process.env.BASE_URL}/payment/linepay/pay/${orderId}`;

    // 推播通知
    const messageText = `💳 付款連結\n` +
      `綠界信用卡（永久有效）：👉 點此付款\n${ecpayUrl}\n\n` +
      `LINE Pay：👉 點此付款\n${linePayPermanent}\n\n` +
      `✅ 付款後系統會自動通知我們`;

    await lineClient.pushMessage(userId, [{ type: 'text', text: messageText }]);

    saveCustomerData({ userId, userName, amount, paymentMethod });
    res.json({ success: true, orderId });
  } catch (err) {
    logger.logError('發送付款連結失敗', err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ============== 模擬 LINE Pay 成功回傳通知 ==============
app.get('/payment/linepay/success/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);
  if (!order) return res.status(404).send('找不到訂單');
  orderManager.updateOrderStatusByUserId(order.userId, 'paid', 'LINE Pay');
  await lineClient.pushMessage(order.userId, [
    { type: 'text', text: `🎉 已成功收到您的付款 NT$${order.amount}，感謝支持！` },
  ]);
  res.send('付款成功，感謝您！');
});

// ============== 兩天自動提醒未付款訂單 ==============
cron.schedule('0 10 * * *', async () => {
  const reminders = orderManager.getOrdersNeedingReminder();
  for (const order of reminders) {
    const msg = `🔔 您還有一筆 NT$${order.amount} 的訂單尚未付款。\n請點下方任一連結完成付款：\n\n` +
      `綠界信用卡：👉 ${order.paymentUrl}\n` +
      `LINE Pay：👉 ${process.env.BASE_URL}/payment/linepay/pay/${order.orderId}`;
    try {
      await lineClient.pushMessage(order.userId, [{ type: 'text', text: msg }]);
      orderManager.markReminderSent(order.orderId);
      logger.logToFile(`📩 自動提醒未付款訂單：${order.orderId}`);
    } catch (err) {
      logger.logError('提醒訊息發送失敗', err);
    }
  }
});

// ============== 每天清理過期訂單 ==============
cron.schedule('0 3 * * *', () => {
  orderManager.cleanExpiredOrders();
});

// ============== 啟動伺服器 ==============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  logger.logToFile(`🚀 Server started on port ${PORT}`);
});