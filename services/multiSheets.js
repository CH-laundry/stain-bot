/**
 * 支援多個 Google Sheets 的客戶記錄服務
 */

class MultiSheetsService {
  constructor(sheetId = null, sheetName = '客戶問題記錄') {
    // 如果沒有指定 sheetId，使用預設的
    this.spreadsheetId = sheetId || process.env.GOOGLE_SHEETS_ID;
    this.apiKey = process.env.GOOGLE_API_KEY;
    this.sheetName = sheetName;
  }

  /**
   * 記錄到指定的 Sheet
   */
  async logToSheet(data, targetSheetId = null) {
    // 可以臨時切換到其他 Sheet
    const sheetId = targetSheetId || this.spreadsheetId;
    
    const timestamp = new Date().toLocaleString('zh-TW', { 
      timeZone: 'Asia/Taipei' 
    });

    const row = [
      timestamp,
      data.customerName || '',
      data.contactInfo || '',
      data.questionType || '',
      data.questionContent || '',
      data.aiResponse || '',
      data.humanResponse || '',
      data.resolved || '待處理',
      data.satisfactionScore || '',
      data.tags || '',
      data.notes || ''
    ];

    try {
      await this.appendToSheet(row, sheetId);
      console.log(`✅ 已記錄到 Sheet: ${sheetId.substring(0, 10)}...`);
      return { success: true, sheetId };
    } catch (error) {
      console.error('❌ 記錄失敗:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 添加數據到指定的 Sheet
   */
  async appendToSheet(rowData, sheetId) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${this.sheetName}:append`;
    
    const response = await fetch(
      `${url}?valueInputOption=RAW&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [rowData] })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || '寫入失敗');
    }

    return await response.json();
  }

  /**
   * 初始化指定的 Sheet
   */
  async initializeSheet(targetSheetId = null) {
    const sheetId = targetSheetId || this.spreadsheetId;
    
    const headers = [
      '時間戳記',
      '客戶姓名',
      '聯絡方式',
      '問題類型',
      '問題內容',
      'AI 回覆',
      '人工回覆',
      '處理狀態',
      '滿意度',
      '標籤',
      '備註'
    ];

    try {
      await this.appendToSheet(headers, sheetId);
      console.log(`✅ Sheet 初始化完成: ${sheetId.substring(0, 10)}...`);
      return { success: true };
    } catch (error) {
      console.error('❌ 初始化失敗:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 從指定的 Sheet 讀取數據
   */
  async fetchData(targetSheetId = null, range = 'A2:K10000') {
    const sheetId = targetSheetId || this.spreadsheetId;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${this.sheetName}!${range}`;
    
    try {
      const response = await fetch(`${url}?key=${this.apiKey}`);
      
      if (!response.ok) {
        throw new Error('讀取失敗');
      }

      const data = await response.json();
      return data.values || [];
    } catch (error) {
      console.error('❌ 讀取失敗:', error.message);
      return [];
    }
  }
}

// ========================================
// 預先建立不同用途的服務實例
// ========================================

// 客戶問題記錄（主要）
const customerLogService = new MultiSheetsService(
  process.env.GOOGLE_SHEETS_ID_CUSTOMER,
  '客戶問題記錄'
);

// 污漬處理專用
const stainLogService = new MultiSheetsService(
  process.env.GOOGLE_SHEETS_ID_STAIN,
  '污漬處理記錄'
);

// 價格報價專用
const priceLogService = new MultiSheetsService(
  process.env.GOOGLE_SHEETS_ID_PRICE,
  '價格報價記錄'
);

// 收送服務專用
const pickupLogService = new MultiSheetsService(
  process.env.GOOGLE_SHEETS_ID_PICKUP,
  '收送服務記錄'
);

// ========================================
// 使用範例
// ========================================

async function exampleUsage() {
  // 記錄客戶問題到主 Sheet
  await customerLogService.logToSheet({
    customerName: '張先生',
    contactInfo: '0912-345-678',
    questionType: 'STAIN',
    questionContent: '紅酒污漬',
    resolved: '已解決'
  });

  // 記錄污漬處理到專用 Sheet
  await stainLogService.logToSheet({
    customerName: '李小姐',
    stainType: '咖啡',
    fabricType: '絲綢',
    successRate: 75
  });

  // 記錄價格詢問到專用 Sheet
  await priceLogService.logToSheet({
    customerName: '王先生',
    questionContent: '西裝乾洗價格',
    aiResponse: 'NT$500'
  });

  // 記錄收送服務到專用 Sheet
  await pickupLogService.logToSheet({
    customerName: '陳小姐',
    questionContent: '明天下午收件',
    resolved: '已安排'
  });

  // 也可以臨時指定其他 Sheet
  const tempService = new MultiSheetsService();
  await tempService.logToSheet(
    { customerName: '臨時記錄' },
    '另一個SheetID'
  );
}

// ========================================
// 批量初始化所有 Sheets
// ========================================

async function initializeAllSheets() {
  console.log('🚀 開始初始化所有 Sheets...\n');

  if (process.env.GOOGLE_SHEETS_ID_CUSTOMER) {
    await customerLogService.initializeSheet();
  }

  if (process.env.GOOGLE_SHEETS_ID_STAIN) {
    await stainLogService.initializeSheet();
  }

  if (process.env.GOOGLE_SHEETS_ID_PRICE) {
    await priceLogService.initializeSheet();
  }

  if (process.env.GOOGLE_SHEETS_ID_PICKUP) {
    await pickupLogService.initializeSheet();
  }

  console.log('\n✅ 所有 Sheets 初始化完成！');
}

// 導出
module.exports = {
  MultiSheetsService,
  customerLogService,
  stainLogService,
  priceLogService,
  pickupLogService,
  initializeAllSheets
};

// 如果直接執行
if (require.main === module) {
  initializeAllSheets();
}
