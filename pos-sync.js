// ========================================
// 🚚 洗衣軟體同步 API
// ========================================

const express = require('express');
const router = express.Router();

// ⭐ 重要:不使用 googleapis,改用你現有的 googleAuth
const googleAuth = require('./services/googleAuth');
const { google } = require('googleapis');

// Google Sheets 寫入函數 (使用 OAuth)
async function appendToSheet(range, values) {
  try {
    console.log('📊 開始寫入 Google Sheets...');
    console.log('  - Range:', range);
    console.log('  - Values:', values);
    
    // 使用你現有的 OAuth 認證
    const auth = googleAuth.getOAuth2Client();
    const sheets = google.sheets({ version: 'v4', auth });
    
    const spreadsheetId = process.env.SPREADSHEET_ID;
    
    if (!spreadsheetId) {
      throw new Error('SPREADSHEET_ID 環境變數未設定');
    }
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
    
    console.log('✅ 寫入成功!');
    
  } catch (error) {
    console.error('❌ Google Sheets 寫入失敗:', error.message);
    throw error;
  }
}

// API 1: 發送通知 → 外送排程
router.post('/delivery-notify', async (req, res) => {
  try {
    console.log('========================================');
    console.log('🚀 收到外送排程請求');
    console.log('📦 請求內容:', JSON.stringify(req.body, null, 2));
    
    const posData = req.body;
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    
    console.log('📝 處理後的資料:');
    console.log('  - 客戶編號:', customerNumber);
    console.log('  - 客戶姓名:', customerName);
    
    await appendToSheet('外送排程!A:J', [
      customerNumber,
      customerName,
      0,
      'sent',
      '',
      `洗衣軟體自動同步 - ${new Date().toLocaleString('zh-TW')}`,
      false,
      new Date().toISOString(),
      posData.ReceivingItemId || '',
      'pos-sync'
    ]);
    
    console.log('✅ 已寫入外送排程');
    console.log('========================================');
    
    res.json({ success: true, message: '✅ 已寫入外送排程' });
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ 錯誤發生!');
    console.error('錯誤訊息:', error.message);
    console.error('錯誤堆疊:', error.stack);
    console.error('========================================');
    
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// API 2: 取消 → 人工通知
router.post('/manual-notify', async (req, res) => {
  try {
    console.log('========================================');
    console.log('🚀 收到人工通知請求');
    console.log('📦 請求內容:', JSON.stringify(req.body, null, 2));
    
    const posData = req.body;
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    
    console.log('📝 處理後的資料:');
    console.log('  - 客戶編號:', customerNumber);
    console.log('  - 客戶姓名:', customerName);
    
    await appendToSheet('人工通知!A:J', [
      customerNumber,
      customerName,
      0,
      'yes',
      `洗衣軟體取消通知 - ${new Date().toLocaleString('zh-TW')}`,
      false,
      false,
      new Date().toISOString(),
      posData.ReceivingItemId || '',
      'pos-sync'
    ]);
    
    console.log('✅ 已寫入人工通知');
    console.log('========================================');
    
    res.json({ success: true, message: '✅ 已寫入人工通知' });
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ 錯誤發生!');
    console.error('錯誤訊息:', error.message);
    console.error('錯誤堆疊:', error.stack);
    console.error('========================================');
    
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// 測試 API
router.get('/status', (req, res) => {
  res.json({ 
    status: 'running', 
    message: '🚚 洗衣軟體同步服務運行中',
    spreadsheetId: process.env.SPREADSHEET_ID ? '已設定' : '未設定',
    googleAuth: googleAuth.isAuthorized() ? '已授權' : '未授權'
  });
});

module.exports = router;
