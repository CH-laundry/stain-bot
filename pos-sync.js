const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const logger = require('./services/logger');

// 🔧 試算表 ID (從環境變數讀取)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '14e1uaQ_4by1W7ELflSIyxo-a48f9LelG4KdkBovyY7s';

// 🔑 取得 Google Auth (改用 Service Account)
function getGoogleAuth() {
  try {
    // 優先使用 Service Account
    if (process.env.GOOGLE_SERVICE_ACCOUNT) {
      console.log('✅ 使用 Service Account 授權');
      const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      return new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
    }
    
    // 備用:使用 OAuth (舊方法)
    console.log('⚠️ 未找到 GOOGLE_SERVICE_ACCOUNT,嘗試使用 OAuth');
    const googleAuth = require('./services/googleAuth');
    return googleAuth.getOAuth2Client();
  } catch (error) {
    console.error('❌ Google 授權失敗:', error.message);
    throw error;
  }
}

// 📊 寫入 Google Sheets
async function appendToSheet(values) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: '外送排程!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
    
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ Google Sheets 寫入失敗:', error.message);
    throw error;
  }
}

// 🚀 接收洗衣軟體的外送通知
router.post('/delivery-notify', async (req, res) => {
  console.log('========================================');
  console.log('🚀 收到外送排程請求');
  console.log('📦 原始請求:', JSON.stringify(req.body, null, 2));
  
  try {
    // 🔄 轉換 Key-Value 格式
    const data = {};
    if (Array.isArray(req.body)) {
      req.body.forEach(item => {
        if (item.Key && item.Value !== undefined) {
          data[item.Key] = item.Value;
        }
      });
    } else {
      Object.assign(data, req.body);
    }
    
    console.log('📦 轉換後資料:', JSON.stringify(data, null, 2));
    
    // 📝 提取資料
    const customerNumber = data.CustomerNumber || data.customerNumber || 'unknown';
    const customerName = data.CustomerName || data.userName || '未知客戶';
    const orderNo = data.ReceivingOrderID || data.orderNo || '';

    // 用客戶編號去 customer-numbers.json 查 LINE 名字
    let lineDisplayName = customerName;
    try {
      const cleanNo = String(customerNumber).replace(/\D/g, '').replace(/^0+/, '');
      const orderManager = require('./services/orderManager');
      const customers = orderManager.getAllCustomerNumbers();
      const found = customers.find(c => {
        const dbNo = String(c.number).replace(/\D/g, '').replace(/^0+/, '');
        return dbNo === cleanNo;
      });
      if (found && found.name) {
        lineDisplayName = found.name;
        console.log(`[delivery-notify] 編號 ${cleanNo} → LINE名字: ${lineDisplayName}（POS: ${customerName}）`);
      } else {
        console.log(`[delivery-notify] 編號 ${cleanNo} 在 customer-numbers 找不到，用 POS 名字: ${customerName}`);
      }
    } catch(e) {
      console.log('[delivery-notify] 查詢 customer-numbers 失敗:', e.message);
    }
    
    console.log('📝 處理後的資料:');
    console.log('  - 客戶編號:', customerNumber);
    console.log('  - 客戶姓名:', customerName);
    
    // 🗓️ 建立時間戳記
    const now = new Date();
    const formattedTime = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    // 📊 準備寫入 Sheets 的資料
    const rowData = [
      customerNumber,           // A: 客戶編號
      lineDisplayName,          // B: 客戶姓名
      0,                        // C: 金額
      'sent',                   // D: 通知狀態
      '',                       // E: 指定日期
      `洗衣軟體自動同步 - ${formattedTime}`, // F: 備註
      false,                    // G: 已簽收
      now.toISOString(),        // H: 建立時間
      orderNo,                  // I: 訂單ID
      'pos-sync'                // J: 來源
    ];
    
    console.log('📊 開始寫入 Google Sheets...');
    console.log('  - Range: 外送排程!A:J');
    console.log('  - Values:', JSON.stringify(rowData, null, 2));
    
    // ✅ 寫入 Google Sheets
    await appendToSheet(rowData);
    
    console.log('✅ 寫入成功!');
    console.log('✅ 已寫入外送排程');

    // 🔥 同步寫入 delivery.json (讓網頁後台看得到)
    try {
      const fs = require('fs');
      const path = require('path');
      const DELIVERY_FILE = path.join(__dirname, 'data', 'delivery.json');
      
      let deliveryData = { orders: [] };
      if (fs.existsSync(DELIVERY_FILE)) {
        deliveryData = JSON.parse(fs.readFileSync(DELIVERY_FILE, 'utf8'));
      }
      
      // 檢查是否已存在
      const exists = deliveryData.orders.some(o => o.orderNo === orderNo);
      
      if (!exists) {
        deliveryData.orders.push({
          id: `DELIVERY_${Date.now()}`,
          orderNo: orderNo || 'unknown',
          customerNumber: customerNumber,
          customerName: lineDisplayName,
          mobile: '',
          status: 'Pending',
          createdAt: new Date().toISOString(),
          signed: false
        });
        
        fs.writeFileSync(DELIVERY_FILE, JSON.stringify(deliveryData, null, 2), 'utf8');
        console.log('✅ 已同步到網頁後台 (delivery.json)');
      } else {
        console.log('⚠️ 訂單已存在於 delivery.json,跳過');
      }
    } catch (err) {
      console.error('⚠️ 同步到 delivery.json 失敗:', err.message);
    }

    console.log('========================================');
    res.json({ success: true, message: '已加入外送排程' });
    
  } catch (error) {
    console.log('========================================');
    console.log('❌ 錯誤發生!');
    console.log('錯誤訊息:', error.message);
    console.log('錯誤堆疊:', error.stack);
    console.log('========================================');
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🔥🔥🔥 新增：接收洗衣軟體的「已簽收」通知
router.post('/signed-notify', async (req, res) => {
  console.log('========================================');
  console.log('✅ 收到已簽收通知');
  console.log('📦 原始請求:', JSON.stringify(req.body, null, 2));
  
  try {
    // 🔄 轉換 Key-Value 格式
    const data = {};
    if (Array.isArray(req.body)) {
      req.body.forEach(item => {
        if (item.Key && item.Value !== undefined) {
          data[item.Key] = item.Value;
        }
      });
    } else {
      Object.assign(data, req.body);
    }
    
    console.log('📦 轉換後資料:', JSON.stringify(data, null, 2));
    
    // 📝 提取資料
    const customerNumber = data.CustomerNumber || data.customerNumber;
    const orderNo = data.ReceivingOrderID || data.orderNo;
    
    console.log('📝 處理後的資料:');
    console.log('  - 客戶編號:', customerNumber);
    console.log('  - 訂單編號:', orderNo);
    
    if (!customerNumber && !orderNo) {
      throw new Error('缺少客戶編號或訂單編號');
    }
    
    // 🔥 更新 delivery.json 為已簽收
    const fs = require('fs');
    const path = require('path');
    const DELIVERY_FILE = path.join(__dirname, 'data', 'delivery.json');
    
    let deliveryData = { orders: [] };
    if (fs.existsSync(DELIVERY_FILE)) {
      deliveryData = JSON.parse(fs.readFileSync(DELIVERY_FILE, 'utf8'));
    }
    
    // 尋找訂單
    let order = null;
    if (orderNo) {
      order = deliveryData.orders.find(o => o.orderNo === orderNo);
    }
    if (!order && customerNumber) {
      // 找最新的未簽收訂單
      order = deliveryData.orders
        .filter(o => o.customerNumber === customerNumber && !o.signed)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    }
    
    if (!order) {
      console.log('⚠️ 找不到訂單，可能尚未建立外送紀錄');
      return res.json({ 
        success: false, 
        error: '找不到訂單（請確認已先建立外送紀錄）' 
      });
    }
    
    // ✅ 更新為已簽收
    order.signed = true;
    order.signedAt = new Date().toISOString();
    order.signedBy = 'pos-sync-auto';
    order.status = 'Completed';
    
    // 💾 儲存
    fs.writeFileSync(DELIVERY_FILE, JSON.stringify(deliveryData, null, 2), 'utf8');
    
    console.log('✅ 已更新為已簽收:', order.customerNumber, order.customerName);
    
    // 🔥 自動刪除取件追蹤記錄
    try {
      const PICKUP_FILE = path.join(__dirname, 'data', 'pickup.json');
      if (fs.existsSync(PICKUP_FILE)) {
        const pickupData = JSON.parse(fs.readFileSync(PICKUP_FILE, 'utf8'));
        if (pickupData.orders) {
          const originalLength = pickupData.orders.length;
          pickupData.orders = pickupData.orders.filter(o => o.customerNumber !== order.customerNumber);
          fs.writeFileSync(PICKUP_FILE, JSON.stringify(pickupData, null, 2), 'utf8');
          
          const deletedCount = originalLength - pickupData.orders.length;
          if (deletedCount > 0) {
            console.log(`✅ 已自動刪除 ${deletedCount} 筆取件追蹤記錄`);
          }
        }
      }
    } catch (pickupErr) {
      console.error('⚠️ 刪除取件追蹤失敗（不影響簽收）:', pickupErr.message);
    }
    
    console.log('========================================');
    res.json({ 
      success: true, 
      message: '已更新為已簽收',
      order: {
        orderNo: order.orderNo,
        customerNumber: order.customerNumber,
        customerName: order.customerName
      }
    });
    
  } catch (error) {
    console.log('========================================');
    console.log('❌ 錯誤發生!');
    console.log('錯誤訊息:', error.message);
    console.log('錯誤堆疊:', error.stack);
    console.log('========================================');
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
