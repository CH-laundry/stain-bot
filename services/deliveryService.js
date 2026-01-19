const orderManager = require('./orderManager');
const customerDB = require('./customerDatabase');

// LINE Client 會從外部傳入
let lineClient = null;

function setLineClient(client) {
  lineClient = client;
  console.log('✅ LINE Client 已設定');
}

// ========================================
// 🔥 新增: 智能查詢 userId (支援多種格式)
// ========================================
async function getUserId(customerNumber, customerName) {
  try {
    console.log(`🔍 開始查詢 userId: ${customerName} (編號: ${customerNumber})`);
    
    // 方法 1: 從客戶編號對應表查詢 (完全匹配)
    const customers = orderManager.getAllCustomerNumbers();
    let customer = customers.find(c => c.number === customerNumber);
    
    if (customer && customer.userId) {
      console.log(`✅ [方法1] 從客戶編號找到: ${customerNumber} → ${customer.userId}`);
      return customer.userId;
    }

    // 方法 2: 嘗試移除前導零後比對
    const numberWithoutZero = customerNumber.replace(/^0+/, '');
    customer = customers.find(c => c.number.replace(/^0+/, '') === numberWithoutZero);
    
    if (customer && customer.userId) {
      console.log(`✅ [方法2] 移除前導零後找到: ${customerNumber} → ${customer.userId}`);
      return customer.userId;
    }

    // 方法 3: 用名字在客戶編號對應表查詢
    customer = customers.find(c => c.name === customerName);
    
    if (customer && customer.userId) {
      console.log(`✅ [方法3] 用名字在對應表找到: ${customerName} → ${customer.userId}`);
      return customer.userId;
    }

    // 方法 4: 從 customerDB 用名字查詢
    console.log(`⚠️ 對應表找不到,嘗試 customerDB...`);
    const searchResults = customerDB.searchCustomers(customerName);
    
    if (searchResults.length > 0 && searchResults[0].userId) {
      console.log(`✅ [方法4] 從 customerDB 找到: ${customerName} → ${searchResults[0].userId}`);
      return searchResults[0].userId;
    }

    // 方法 5: 從 /data/users.json 查詢
    console.log(`⚠️ customerDB 也找不到,嘗試 users.json...`);
    const fs = require('fs');
    const USERS_FILE = '/data/users.json';
    
    if (fs.existsSync(USERS_FILE)) {
      const userList = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      const user = userList.find(u => u.name === customerName);
      
      if (user && user.userId) {
        console.log(`✅ [方法5] 從 users.json 找到: ${customerName} → ${user.userId}`);
        return user.userId;
      }
    }

    // 全部方法都失敗
    console.log(`❌ 完全找不到 userId: ${customerName} (${customerNumber})`);
    console.log(`📋 客戶對應表總數: ${customers.length} 筆`);
    
    return null;
    
  } catch (error) {
    console.error('❌ 查詢 userId 時發生錯誤:', error);
    return null;
  }
}

// ========================================
// 功能1: 金額=0時的簡單通知
// ========================================
async function markSignedSimple(deliveryId, customerNumber, customerName) {
  try {
    console.log(`[外送通知] 處理已簽收: ${customerName} (${customerNumber})`);
    
    // 🔥 使用智能查詢
    const userId = await getUserId(customerNumber, customerName);
    
    if (!userId) {
      console.log(`⚠️ 客戶 ${customerName} 沒有 LINE 綁定,跳過通知`);
      return { 
        success: true, 
        message: '已簽收 (客戶未綁定 LINE,未發送通知)', 
        notified: false 
      };
    }

    // 發送 LINE 訊息
    const message = '已經送回管理室了💙謝謝您';
    
    if (!lineClient) {
      throw new Error('LINE Client 未初始化');
    }
    
    await lineClient.pushMessage(userId, {
      type: 'text',
      text: message
    });
    
    console.log(`✅ 已簽收並通知(金額=0): ${customerName}`);
    return { success: true, notified: true };
    
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
    console.log(`[外送付款] 處理已簽收: ${customerName} - NT$${amount}`);
    
    // 🔥 使用智能查詢
    const userId = await getUserId(customerNumber, customerName);
    
    if (!userId) {
      console.log(`⚠️ 客戶 ${customerName} 沒有 LINE 綁定,跳過通知`);
      return { 
        success: true, 
        message: '已簽收 (客戶未綁定 LINE,未發送通知)', 
        notified: false 
      };
    }

    // 使用外送單號作為訂單編號
    let orderId = deliveryId;
    
    if (!orderId) {
      orderId = `DL${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      console.log('⚠️ 警告: 沒有外送單號,系統自動產生了亂碼 ID (無法自動同步)');
    }
    
    // 創建訂單
    orderManager.createOrder(orderId, {
      userId: userId,
      userName: customerName,
      amount: amount
    });
    
    console.log(`✅ 已創建訂單(外送): ${orderId}`);
    
    // 生成支付連結
    const rawBase = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BASE_URL || 'https://stain-bot-production-2593.up.railway.app';
    const baseURL = rawBase.startsWith('http') ? rawBase : 'https://' + rawBase;
    
    const ecpayUrl = `${baseURL}/payment/ecpay/pay/${orderId}`;
    const linepayUrl = `${baseURL}/payment/linepay/pay/${orderId}`;
    
    // 發送 LINE 訊息 + 支付連結
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
    
    console.log(`✅ 已簽收並發送支付: ${customerName}, 訂單: ${orderId}`);
    
    return {
      success: true,
      orderId: orderId,
      notified: true
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
