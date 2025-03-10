const { google } = require('googleapis');
const path = require('path');
require('dotenv').config(); // 使用 dotenv 來讀取環境變數

async function getSheet() {
  try {
    // 檢查環境變數是否存在
    if (!process.env.GOOGLE_SHEETS_CREDS || !process.env.GOOGLE_SHEETS_ID) {
      throw new Error('Missing environment variables: GOOGLE_SHEETS_CREDS or GOOGLE_SHEETS_ID');
    }

    // 使用環境變數中的絕對路徑
    const credsPath = process.env.GOOGLE_SHEETS_CREDS;
    console.log('Resolved Credentials Path:', credsPath); // 打印路徑以確認

    // 建立認證資訊
    const auth = new google.auth.GoogleAuth({
      keyFile: credsPath, // 使用環境變數中的路徑
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    // 建立 Sheets API 客戶端
    const sheets = google.sheets({ version: 'v4', auth });

    // 從環境變數中讀取 Google Sheet ID 和範圍
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const range = 'C.H FAQ 自動回覆!A1:D10'; // 請替換為您想讀取的範圍

    // 讀取資料
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    // 檢查是否有資料
    if (!res.data || !res.data.values) {
      throw new Error('No data found in the specified range.');
    }

    // 返回讀取到的資料
    return res.data.values;
  } catch (error) {
    console.error('Error in getSheet:', error);
    return null;
  }
}

module.exports = { getSheet };
