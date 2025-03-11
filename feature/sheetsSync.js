const { google } = require('googleapis');
const XLSX = require('xlsx');

async function syncGoogleSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'A:C',
    valueRenderOption: 'FORMATTED_VALUE', // 确保获取计算后的值而非公式
  });

  const ws = XLSX.utils.aoa_to_sheet(response.data.values);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, 'CH資料庫.xlsx');

  console.log('[同步] 數據同步完成 (已使用FORMATTED_VALUE)');
}

module.exports = { syncGoogleSheets };
