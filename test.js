require('dotenv').config();
const { customerLogService } = require('./services/multiSheets');

async function test() {
  // 初始化表頭
  await customerLogService.initializeSheet();
  
  // 記錄一筆測試資料
  await customerLogService.logToSheet({
    customerName: '測試客戶',
    contactInfo: '0912-345-678',
    questionType: 'STAIN',
    questionContent: '紅酒污漬',
    aiResponse: '建議使用冷水+白醋',
    resolved: '已解答'
  });
  
  console.log('測試完成！請檢查你的 Google Sheets');
}

test();
