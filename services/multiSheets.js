/**
 * 支援多個 Google Sheets 的客戶記錄服務 (使用 OAuth 2.0)
 */
const { google } = require('googleapis');
const googleAuth = require('./googleAuth');

class MultiSheetsService {
  constructor(sheetId = null, sheetName = '客戶問題記錄') {
    // 從環境變數讀取,或使用預設值
    this.spreadsheetId = sheetId || process.env.GOOGLE_SHEETS_ID_CUSTOMER || '1Cfavtl8HGpQDeibPi-qeUOqbfuFKTM68kUAjR6uQYVI';
    this.sheetName = sheetName;
    
    if (!this.spreadsheetId) {
      console.warn('⚠️  Google Sheets 配置未完成');
    }
  }

  /**
   * 取得已授權的 Sheets API 實例
   */
  getSheetsAPI() {
    const auth = googleAuth.getOAuth2Client();
    return google.sheets({ version: 'v4', auth });
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
      // 檢查是否已授權
      if (!googleAuth.isAuthorized()) {
        console.warn('⚠️  尚未完成 OAuth 授權');
        return { success: false, error: '尚未完成 OAuth 授權' };
      }

      await this.appendToSheet(row, sheetId);
      console.log(`✅ 已記錄到 Sheet: ${sheetId.substring(0, 10)}...`);
      return { success: true, sheetId };
    } catch (error) {
      console.error('❌ 記錄失敗:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 添加數據到指定的 Sheet (使用 OAuth 2.0)
   */
  async appendToSheet(rowData, sheetId) {
    const sheets = this.getSheetsAPI();
    
    try {
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${this.sheetName}!A:K`,  // 使用整列範圍
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [rowData]
        }
      });
      
      return response.data;
    } catch (error) {
      console.error('❌ API 錯誤:', error.message);
      throw new Error(`寫入失敗: ${error.message}`);
    }
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
      // 檢查是否已授權
      if (!googleAuth.isAuthorized()) {
        console.warn('⚠️  尚未完成 OAuth 授權');
        return { success: false, error: '尚未完成 OAuth 授權' };
      }

      await this.appendToSheet(headers, sheetId);
      console.log(`✅ Sheet 初始化完成: ${sheetId.substring(0, 10)}...`);
      return { success: true };
    } catch (error) {
      console.error('❌ 初始化失敗:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 從指定的 Sheet 讀取數據 (使用 OAuth 2.0)
   */
  async fetchData(targetSheetId = null, range = 'A2:K10000') {
    const sheetId = targetSheetId || this.spreadsheetId;
    const sheets = this.getSheetsAPI();
    
    try {
      // 檢查是否已授權
      if (!googleAuth.isAuthorized()) {
        console.warn('⚠️  尚未完成 OAuth 授權');
        return [];
      }

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${this.sheetName}!${range}`
      });
      
      return response.data.values || [];
    } catch (error) {
      console.error('❌ 讀取失敗:', error.message);
      return [];
    }
  }

  /**
   * 上傳圖片到 Google Drive 並取得連結
   */
  async uploadImageToDrive(imageBuffer, filename) {
    try {
      // 檢查是否已授權
      if (!googleAuth.isAuthorized()) {
        console.warn('⚠️  尚未完成 OAuth 授權');
        return { success: false, error: '尚未完成 OAuth 授權' };
      }

      const auth = googleAuth.getOAuth2Client();
      const drive = google.drive({ version: 'v3', auth });
      
      // 建立檔案 metadata
      const fileMetadata = {
        name: filename,
        // 可選:指定資料夾 ID
        // parents: ['YOUR_FOLDER_ID']
      };
      
      // 上傳檔案
      const media = {
        mimeType: 'image/jpeg',
        body: require('stream').Readable.from(imageBuffer)
      };
      
      const file = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, webViewLink, webContentLink'
      });
      
      // 設定檔案為公開可讀取 (讓你可以在試算表中預覽)
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });
      
      console.log(`✅ 圖片已上傳到 Drive: ${file.data.id}`);
      
      return {
        success: true,
        fileId: file.data.id,
        viewLink: file.data.webViewLink,
        downloadLink: file.data.webContentLink
      };
    } catch (error) {
      console.error('❌ 上傳圖片失敗:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 記錄客戶問題並包含圖片連結
   */
  async logWithImage(data, imageBuffer, imageName, targetSheetId = null) {
    try {
      // 先上傳圖片
      const uploadResult = await this.uploadImageToDrive(imageBuffer, imageName);
      
      if (!uploadResult.success) {
        console.error('圖片上傳失敗,僅記錄文字資料');
      } else {
        // 將圖片連結加入備註
        data.notes = `圖片連結: ${uploadResult.viewLink}\n${data.notes || ''}`;
      }
      
      // 記錄到 Sheet
      return await this.logToSheet(data, targetSheetId);
    } catch (error) {
      console.error('❌ 記錄失敗:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// 創建單例
const customerLogService = new MultiSheetsService();

module.exports = {
  MultiSheetsService,
  customerLogService
};
