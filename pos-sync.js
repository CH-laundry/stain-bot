const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const googleAuth = require('./services/googleAuth');
const logger = require('./services/logger');

// 🔧 試算表 ID (從環境變數讀取)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '14e1uaQ_4by1W7ELflSIyxo-a48f9LelG4KdkBovyY7s';

// 📊 寫入 Google Sheets
async function appendToSheet(values) {
  try {
    const auth = googleAuth.getOAuth2Client();
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
    
    // 📝 提取資料 (✅ 修正:優先使用 CustomerName)
    const customerNumber = data.CustomerNumber || data.customerNumber || 'unknown';
    const customerName = data.CustomerName || data.userName || '未知客戶';
    const orderNo = data.ReceivingOrderID || data.orderNo || '';
    
    console.log('📝 處理後的資料:');
    console.log('  - 客戶編號:', customerNumber);
    console.log('  - 客戶姓名:', customerName);
    
    // 🗓️ 建立時間戳記
    const now = new Date();
    const formattedTime = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    // 📊 準備寫入 Sheets 的資料
    const rowData = [
      customerNumber,           // A: 客戶編號
      customerName,             // B: 客戶姓名
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
          customerName: customerName,
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

module.exports = router;
