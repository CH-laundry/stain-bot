const messageService = require('./message');
const orderManager = require('./orderManager');
const customerDB = require('./customerDB');

// ========================================
// 功能1: 金額=0時的簡單通知
// ========================================
async function markSignedSimple(deliveryId, customerNumber, customerName) {
  try {
    // 1. 從客戶編號查詢 userId
    const customer = await customerDB.getCustomerByNumber(customerNumber);
    if (!customer || !customer.userId) {
      throw new Error('找不到客戶 User ID');
    }

    // 2. 發送 LINE 訊息
    const message = '已經送回管理室了💙謝謝您';
    await messageService.sendTextMessage(customer.userId, message);

    // 3. 標記外送紀錄為已簽收
    // 這裡需要你有外送紀錄的資料庫操作
    // await deliveryDB.update(deliveryId, { signed: true });

    console.log(`✅ 已簽收(金額=0): ${customerName}`);
    return { success: true };

  } catch (error) {
    console.error('❌ markSignedSimple 失敗:', error);
    throw error;
  }
}

// ========================================
// 功能2: 金額>0時發送支付連結+追蹤
// ========================================
async function markSignedWithPayment(deliveryId, customerNumber, customerName, amount) {
  try {
    // 1. 從客戶編號查詢 userId
    const customer = await customerDB.getCustomerByNumber(customerNumber);
    if (!customer || !customer.userId) {
      throw new Error('找不到客戶 User ID');
    }

    const userId = customer.userId;

    // 2. 創建訂單 (使用現有的 orderManager)
    const orderResult = await orderManager.createOrder({
      userId: userId,
      userName: customerName,
      amount: amount,
      paymentType: 'both', // 兩種支付方式都發
      customMessage: '', // 不需要額外訊息
      deliveryRecordId: deliveryId, // ⭐ 關聯外送紀錄
      autoReminderEnabled: true, // ⭐ 啟用自動提醒
      nextReminderAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) // ⭐ 2天後提醒
    });

    if (!orderResult.success) {
      throw new Error('創建訂單失敗: ' + orderResult.error);
    }

    const orderId = orderResult.orderId;
    const linePayUrl = orderResult.linePayUrl;
    const ecpayUrl = orderResult.ecpayUrl;

    // 3. 發送 LINE 訊息 + 支付連結
    const message = 
      `已經送回管理室了💙金額是 NT$ ${amount.toLocaleString()},以下提供兩種付款方式,您可以依方便選擇 謝謝您\n\n` +
      `💚 LINE Pay 付款:\n${linePayUrl}\n\n` +
      `💳 信用卡付款:\n${ecpayUrl}`;

    await messageService.sendTextMessage(userId, message);

    // 4. 標記外送紀錄為已簽收並關聯訂單
    // await deliveryDB.update(deliveryId, {
    //   signed: true,
    //   orderId: orderId,
    //   paymentSentAt: new Date()
    // });

    console.log(`✅ 已簽收+發送支付: ${customerName}, 訂單: ${orderId}`);
    
    return {
      success: true,
      orderId: orderId
    };

  } catch (error) {
    console.error('❌ markSignedWithPayment 失敗:', error);
    throw error;
  }
}

module.exports = {
  markSignedSimple,
  markSignedWithPayment
};
