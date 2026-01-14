// ========================================
// 🚚 洗衣軟體同步 API (整合進主系統)
// ========================================

const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

// Google Sheets 寫入函數
async function appendToSheet(range, values) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  
  const sheets = google.sheets({ version: 'v4', auth });
  
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: range,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  });
}

// API 1: 發送通知 → 外送排程
router.post('/delivery-notify', async (req, res) => {
  try {
    const posData = req.body;
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    
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
    
    res.json({ success: true, message: '✅ 已寫入外送排程' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 2: 取消 → 人工通知
router.post('/manual-notify', async (req, res) => {
  try {
    const posData = req.body;
    const customerNumber = (posData.ReceivingOrderNumber || '').replace(/^0+/, '') || 'unknown';
    const customerName = posData.userName || '未知客戶';
    
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
    
    res.json({ success: true, message: '✅ 已寫入人工通知' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 測試 API
router.get('/status', (req, res) => {
  res.json({ status: 'running', message: '🚚 洗衣軟體同步服務運行中' });
});

module.exports = router;
