require('dotenv').config();
const { customerLogService } = require('./services/multiSheets');

async function test() {
  console.log('開始測試 Google Sheets...');
  
  try {
    await customerLogService.initializeSheet();
    
    await customerLogService.logToSheet({
      customerName: '測試客戶',
      contactInfo: '0912-345-678',
      questionType: 'STAIN',
      questionContent: '紅酒污漬',
      aiResponse: '建議冷水+白醋',
      resolved: '已解答'
    });
    
    console.log('✅ 完成！請檢查 Google Sheets');
  } catch (error) {
    console.error('❌ 錯誤:', error);
  }
}

test();
