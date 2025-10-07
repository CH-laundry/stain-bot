/**
 * 支援多個 Google Sheets 的客戶記錄服務
 */

class MultiSheetsService {
  constructor(sheetId = null, sheetName = '客戶問題記錄') {
    // 暫時直接寫死測試
    this.spreadsheetId = '1Cfavtl8HGpQDeibPi-qeUOqbfuFKTM68kUAjR6uQYVI';
    this.apiKey = 'AIzaSyA6G9TBMcOhaIQ_Mqz7hSNV7ULGUpfGHa8';
    this.sheetName = sheetName;
    
    if (!this.spreadsheetId || !this.apiKey) {
      console.warn('⚠️  Google Sheets 配置未完成');
    }
  }

  /**
   * 記錄到指定的 Sheet
   */
  async logToSheet(data, targetSheetId = null) {
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
      const errorText = await response.text();
      console.error('API 錯誤回應:', errorText);
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
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

// 創建單例
const customerLogService = new MultiSheetsService();

module.exports = {
  MultiSheetsService,
  customerLogService
};
