const orderManager = require('./orderManager');

// LINE Client 會從外部傳入
let lineClient = null;

function setLineClient(client) {
  lineClient = client;
}

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
    
    if (!lineClient) {
      throw new Error('LINE Client 未初始化');
    }
    
    await lineClient.pushMessage(customer.userId, {
      type: 'text',
      text: message
    });

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

    // 🔥🔥🔥 【關鍵修改】不再產生亂碼，直接使用外送單號作為訂單編號 🔥🔥🔥
    // 這樣 Python 機器人才能拿著這個號碼去洗衣店軟體入帳
    let orderId = deliveryId;

    // 防呆機制：如果 deliveryId 是空的，才不得已產生亂碼
    if (!orderId) {
        orderId = `DL${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        console.log('⚠️ 警告: 沒有外送單號，系統自動產生了亂碼 ID (無法自動同步)');
    }

    // 3. 創建訂單
    orderManager.createOrder(orderId, {
      userId: userId,
      userName: customerName,
      amount: amount
    });

    console.log(`✅ 已創建訂單(外送): ${orderId}`);

    // 4. 生成支付連結
    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app';
    const baseURL = rawBase.startsWith('http') ? rawBase : 'https://' + rawBase;
    
    const ecpayUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayUrl = `${baseURL}/payment/linepay/pay/${orderId}`;

    // 5. 發送 LINE 訊息 + 支付連結
    const message = 
      `已經送回管理室了💙金額是 NT$ ${amount.toLocaleString()},以下提供兩種付款方式,您可以依方便選擇 謝謝您\n\n` +
      `訂單編號: ${orderId}\n\n` +
      `💚 LINE Pay 付款:\n${linepayUrl}\n\n` +
      `💳 信用卡付款:\n${ecpayUrl}`;

    if (!lineClient) {
      throw new Error('LINE Client 未初始化');
    }

    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });

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
  setLineClient,
  markSignedSimple,
  markSignedWithPayment
};
