// ====================================
// 每週 AI 客服分析系統
// ====================================

const { google } = require('googleapis');

// 讀取 Google Sheets 認證
let auth = null;
try {
  const credentials = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (credentials) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }
} catch (error) {
  console.error('週報系統：Google Sheets 認證失敗', error);
}

// 分析過去 7 天的對話記錄
async function analyzeWeeklyData() {
  try {
    if (!auth || !process.env.LEARNING_SHEET_ID) {
      console.log('⚠️ 週報系統未啟用');
      return null;
    }

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    // 讀取對話記錄
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.LEARNING_SHEET_ID,
      range: '對話記錄!A:H'
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return { error: '沒有對話記錄' };
    }

    // 取得過去 7 天的資料
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const recentData = rows.slice(1).filter(row => {
      if (!row[0]) return false;
      const rowDate = new Date(row[0]);
      return rowDate >= sevenDaysAgo && rowDate <= today;
    });

    if (recentData.length === 0) {
      return { error: '過去 7 天沒有對話記錄' };
    }

    // 統計分析
    const analysis = {
      totalChats: recentData.length,
      complaints: 0,
      impatient: 0,
      normal: 0,
      questionTypes: {},
      complaintCases: [],
      impatientCases: []
    };

    recentData.forEach((row, index) => {
      const [date, time, userId, userMsg, aiReply, questionType, emotion, status] = row;
      
      // 統計情緒
      if (emotion && emotion.includes('客訴')) {
        analysis.complaints++;
        analysis.complaintCases.push({
          date, time, userMsg, aiReply, emotion
        });
      } else if (emotion && emotion.includes('不耐煩')) {
        analysis.impatient++;
        analysis.impatientCases.push({
          date, time, userMsg, aiReply, emotion
        });
      } else {
        analysis.normal++;
      }

      // 統計問題類型
      if (questionType) {
        analysis.questionTypes[questionType] = (analysis.questionTypes[questionType] || 0) + 1;
      }
    });

    // 排序高頻問題
    analysis.topQuestions = Object.entries(analysis.questionTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({
        type,
        count,
        percentage: ((count / analysis.totalChats) * 100).toFixed(1)
      }));

    return analysis;

  } catch (error) {
    console.error('週報分析失敗:', error);
    return { error: error.message };
  }
}

module.exports = {
  analyzeWeeklyData
};
