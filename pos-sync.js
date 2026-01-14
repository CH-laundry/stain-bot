// ========================================
// 🚚 洗衣軟體同步服務 (獨立運行)
// ========================================

const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ========================================
// 📊 Google Sheets 寫入函數
// ========================================
async function appendToSheet(range, values) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [values]
      }
    });
    
    console.log(`✅ 成功寫入: ${range}`);
    return true;
    
  } catch (error) {
    console.error(`❌ 寫入失敗: ${error.message}`);
    throw error;
  }
}

// ========================================
// 🚚 API 1: 發送通知 → 外送排程
// ========================================
app.post('/api/pos-sync/delivery-notify', async (req, res) => {
  try {
    console.log('\n📦 收到「發送通知」請求');
    console.log('原始資料:', JSON.stringify(req.body, null, 2));
    
    const posData = req.body;
    
    // 提取關鍵資訊
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    const receivingItemId = posData.ReceivingItemId || '';
    
    console.log('解析結果:', {
      customerNumber,
      customerName,
      receivingItemId
    });
    
    // 寫入「外送排程」表
    const rowData = [
      customerNumber,                                                    // A: 客戶編號
      customerName,                                                     // B: 客戶姓名
      0,                                                                // C: 金額 (待手動輸入)
      'sent',                                                           // D: 通知狀態 (已發送自動通知)
      '',                                                               // E: 指定外送日期 (空白)
      `洗衣軟體自動同步 - ${new Date().toLocaleString('zh-TW')}`,      // F: 備註
      false,                                                            // G: 已簽收 (false)
      new Date().toISOString(),                                         // H: 建立時間
      receivingItemId,                                                  // I: 訂單ID
      'pos-sync'                                                        // J: 來源標記
    ];
    
    await appendToSheet('外送排程!A:J', rowData);
    
    res.json({ 
      success: true, 
      message: '✅ 已寫入外送排程',
      data: {
        customerNumber,
        customerName,
        target: '外送排程'
      }
    });
    
  } catch (error) {
    console.error('❌ 處理失敗:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========================================
// 📝 API 2: 取消 → 人工通知
// ========================================
app.post('/api/pos-sync/manual-notify', async (req, res) => {
  try {
    console.log('\n📝 收到「取消」請求');
    console.log('原始資料:', JSON.stringify(req.body, null, 2));
    
    const posData = req.body;
    
    // 提取關鍵資訊
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    const receivingItemId = posData.ReceivingItemId || '';
    
    console.log('解析結果:', {
      customerNumber,
      customerName,
      receivingItemId
    });
    
    // 寫入「人工通知」表
    const rowData = [
      customerNumber,                                                    // A: 客戶編號
      customerName,                                                     // B: 客戶姓名
      0,                                                                // C: 金額 (待手動輸入)
      'yes',                                                            // D: 需要外送 (預設是)
      `洗衣軟體取消通知 - ${new Date().toLocaleString('zh-TW')}`,      // E: 內容
      false,                                                            // F: 已通知 (false)
      false,                                                            // G: 已付款 (false)
      new Date().toISOString(),                                         // H: 建立時間
      receivingItemId,                                                  // I: 訂單ID
      'pos-sync'                                                        // J: 來源標記
    ];
    
    await appendToSheet('人工通知!A:J', rowData);
    
    res.json({ 
      success: true, 
      message: '✅ 已寫入人工通知',
      data: {
        customerNumber,
        customerName,
        target: '人工通知'
      }
    });
    
  } catch (error) {
    console.error('❌ 處理失敗:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ========================================
// 🔍 測試 API
// ========================================
app.get('/api/pos-sync/status', (req, res) => {
  res.json({
    status: 'running',
    message: '🚚 洗衣軟體同步服務運行中',
    timestamp: new Date().toISOString()
  });
});

// ========================================
// 🚀 啟動服務
// ========================================
const PORT = process.env.POS_SYNC_PORT || 3001;

app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🚚 洗衣軟體同步服務已啟動');
  console.log(`📡 監聽端口: ${PORT}`);
  console.log(`🌐 本地測試: http://localhost:${PORT}/api/pos-sync/status`);
  console.log('========================================\n');
});
