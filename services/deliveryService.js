const messageService = require('./message');
const orderManager = require('./orderManager');

// ========================================
// 功能1: 金額=0時的簡單通知
// ========================================
async function markSignedSimple(deliveryId, customerNumber, customerName) {
  try {
    // 1. 從客戶編號查詢 userId
    const customers = orderManager.getAllCustomerNumbers();
    const customer = customers.find(c => c.number === customerNumber);
    
    if (!customer || !customer.userId) {
      throw new Error('找不到客戶 User ID');
    }

    // 2. 發送 LINE 訊息
    const message = '已經送回管理室了💙謝謝您';
    await messageService.sendTextMessage(customer.userId, message);

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
    const customers = orderManager.getAllCustomerNumbers();
    const customer = customers.find(c => c.number === customerNumber);
    
    if (!customer || !customer.userId) {
      throw new Error('找不到客戶 User ID');
    }

    const userId = customer.userId;

    // 2. 創建訂單編號
    const orderId = `DL${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    // 3. 創建訂單
    orderManager.createOrder(orderId, {
      userId: userId,
      userName: customerName,
      amount: amount
    });

    console.log(`✅ 已創建訂單: ${orderId}`);

    // 4. 生成支付連結
    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app';
    const baseURL = rawBase.startsWith('http') ? rawBase : 'https://' + rawBase;
    
    const ecpayUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    // 5. 發送 LINE 訊息 + 支付連結
    const message = 
      `已經送回管理室了💙金額是 NT$ ${amount.toLocaleString()},以下提供兩種付款方式,您可以依方便選擇 謝謝您\n\n` +
      `💚 LINE Pay 付款:\n${linepayUrl}\n\n` +
      `💳 信用卡付款:\n${ecpayUrl}`;

    await messageService.sendTextMessage(userId, message);

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
