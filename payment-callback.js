// ========================================
// 付款回調處理模組 - payment-callback.js
// ========================================
const crypto = require('crypto');
const { Client } = require('@line/bot-sdk');

// LINE Bot 設定
const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 管理員 USER ID（你的個人 LINE）
const ADMIN_USER_IDS = [
  'U5099169723d6e83588c5f23dfaf6f9cf'  // 你的個人 LINE ID
];

/**
 * 綠界付款通知接收端點
 * POST /payment/ecpay/callback
 */
async function handleECPayCallback(req, res) {
  try {
    console.log('========================================');
    console.log('📥 收到綠界付款通知');
    console.log('時間:', new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
    console.log('內容:', JSON.stringify(req.body, null, 2));
    console.log('========================================');

    // 1. 驗證綠界的檢查碼（CheckMacValue）
    const receivedCheckMac = req.body.CheckMacValue;
    const calculatedCheckMac = generateECPayCheckMac(req.body);

    if (receivedCheckMac !== calculatedCheckMac) {
      console.error('❌ 綠界檢查碼驗證失敗');
      console.error('收到的:', receivedCheckMac);
      console.error('計算的:', calculatedCheckMac);
      return res.status(200).send('0|CheckMacValue Error');
    }

    console.log('✅ 檢查碼驗證通過');

    // 2. 解析付款資訊
    const {
      MerchantTradeNo,  // 商店訂單編號
      TradeNo,          // 綠界交易編號
      RtnCode,          // 交易狀態碼 (1 = 成功)
      RtnMsg,           // 交易訊息
      TradeAmt,         // 交易金額
      PaymentDate,      // 付款時間
      PaymentType,      // 付款方式
      CustomField1,     // 自訂欄位1（客戶 LINE ID）
      CustomField2,     // 自訂欄位2（客戶名稱）
    } = req.body;

    // 3. 判斷付款是否成功
    if (RtnCode === '1') {
      console.log('✅ 付款成功！開始發送通知...');

      // 4. 通知管理員
      const adminMessage = `
🎉 收到新的付款通知

💰 金額: NT$ ${TradeAmt}
📋 訂單編號: ${MerchantTradeNo}
🔢 綠界交易號: ${TradeNo}
💳 付款方式: ${getPaymentTypeText(PaymentType)}
⏰ 付款時間: ${PaymentDate}
👤 客戶資訊: ${CustomField2 || '未提供'}
🆔 客戶ID: ${CustomField1 || '未提供'}

請盡快處理訂單！
      `.trim();

      // 發送通知給所有管理員
      await notifyAdmins(adminMessage);

      // 5. 如果有客戶的 LINE ID，也通知客戶
      if (CustomField1 && CustomField1.startsWith('U')) {
        const customerMessage = `
✅ 付款成功確認

感謝您的付款！

📋 訂單編號: ${MerchantTradeNo}
💰 金額: NT$ ${TradeAmt}
⏰ 時間: ${PaymentDate}

我們已收到您的款項，會盡快為您處理 😊
如有任何問題，請隨時與我們聯繫。
        `.trim();

        try {
          await lineClient.pushMessage(CustomField1, {
            type: 'text',
            text: customerMessage
          });
          console.log(`✅ 已通知客戶: ${CustomField1}`);
        } catch (err) {
          console.error(`❌ 通知客戶失敗: ${err.message}`);
        }
      }

      // 6. 回傳成功給綠界（必須回傳 "1|OK"）
      console.log('✅ 回傳 1|OK 給綠界');
      return res.status(200).send('1|OK');

    } else {
      console.log('❌ 付款失敗:', RtnMsg);
      
      // 即使失敗也通知管理員
      const failMessage = `
⚠️ 付款失敗通知

📋 訂單編號: ${MerchantTradeNo}
❌ 失敗原因: ${RtnMsg}
💰 金額: NT$ ${TradeAmt}
👤 客戶: ${CustomField2 || '未提供'}
      `.trim();
      
      await notifyAdmins(failMessage);
      
      return res.status(200).send('1|OK');
    }

  } catch (error) {
    console.error('💥 處理綠界回調時發生錯誤:', error);
    console.error('錯誤堆疊:', error.stack);
    return res.status(200).send('0|Error');
  }
}

/**
 * LINE PAY 付款通知接收端點
 * POST /payment/linepay/callback
 */
async function handleLinePayCallback(req, res) {
  try {
    console.log('========================================');
    console.log('📥 收到 LINE PAY 付款通知');
    console.log('時間:', new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }));
    console.log('內容:', JSON.stringify(req.body, null, 2));
    console.log('========================================');

    // LINE PAY 通常會透過 query string 傳遞
    const { transactionId, orderId } = req.query;
    
    if (transactionId && orderId) {
      console.log('✅ LINE PAY 付款成功');
      
      const message = `
🎉 收到 LINE PAY 付款通知

📋 訂單編號: ${orderId}
🔢 交易編號: ${transactionId}
⏰ 時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}

請盡快處理訂單！
      `.trim();

      await notifyAdmins(message);

      return res.status(200).json({ 
        returnCode: '0000', 
        returnMessage: 'Success' 
      });
    }

    console.log('⚠️ LINE PAY 回調參數不完整');
    return res.status(400).json({ 
      returnCode: '1104', 
      returnMessage: 'Invalid request' 
    });

  } catch (error) {
    console.error('💥 處理 LINE PAY 回調時發生錯誤:', error);
    console.error('錯誤堆疊:', error.stack);
    return res.status(500).json({ 
      returnCode: '9999', 
      returnMessage: 'System error' 
    });
  }
}

/**
 * 生成綠界檢查碼
 */
function generateECPayCheckMac(params) {
  const {
    ECPAY_HASH_KEY,
    ECPAY_HASH_IV
  } = process.env;

  if (!ECPAY_HASH_KEY || !ECPAY_HASH_IV) {
    throw new Error('缺少綠界 HASH_KEY 或 HASH_IV 環境變數');
  }

  // 1. 移除 CheckMacValue
  const data = { ...params };
  delete data.CheckMacValue;

  // 2. 按照 key 排序
  const sortedKeys = Object.keys(data).sort();
  
  // 3. 組合字串
  let checkString = `HashKey=${ECPAY_HASH_KEY}`;
  sortedKeys.forEach(key => {
    checkString += `&${key}=${data[key]}`;
  });
  checkString += `&HashIV=${ECPAY_HASH_IV}`;

  // 4. URL encode（綠界特殊規則）
  checkString = encodeURIComponent(checkString)
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .toLowerCase();

  // 5. SHA256 加密並轉大寫
  const checkMacValue = crypto
    .createHash('sha256')
    .update(checkString)
    .digest('hex')
    .toUpperCase();

  return checkMacValue;
}

/**
 * 通知所有管理員
 */
async function notifyAdmins(message) {
  const promises = ADMIN_USER_IDS.map(async (adminId) => {
    try {
      await lineClient.pushMessage(adminId, {
        type: 'text',
        text: message
      });
      console.log(`✅ 已通知管理員: ${adminId}`);
    } catch (err) {
      console.error(`❌ 發送訊息給管理員 ${adminId} 失敗:`, err.message);
    }
  });

  await Promise.all(promises);
  console.log('✅ 管理員通知完成');
}

/**
 * 取得付款方式文字
 */
function getPaymentTypeText(type) {
  const types = {
    'Credit_CreditCard': '信用卡',
    'WebATM_TAISHIN': '台新WebATM',
    'WebATM_ESUN': '玉山WebATM',
    'WebATM_BOT': '台銀WebATM',
    'ATM_TAISHIN': '台新ATM',
    'ATM_ESUN': '玉山ATM',
    'ATM_BOT': '台銀ATM',
    'CVS_CVS': '超商代碼',
    'BARCODE_BARCODE': '超商條碼',
  };
  return types[type] || type;
}

module.exports = {
  handleECPayCallback,
  handleLinePayCallback
};
