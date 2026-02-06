const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { OpenAI } = require('openai');

// ==================== 設定區 ====================
const CONFIG = {
  SPREADSHEET_ID: '14e1uaQ_4by1W7ELflSIyxo-a48f9LelG4KdkBovyY7s',
  SHEET_NAME: 'C.H 洗衣 AI 學習記錄',
  EMAIL_TO: 'todayeasy2002@gmail.com',
  FORECAST_DAYS: 14,
  SMTP: {
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==================== Google Sheets 連接 ====================
async function getGoogleSheetsClient() {
  // 🔥 修正:使用現有的 googleAuth 模組
  const googleAuth = require('./services/googleAuth');
  
  if (!googleAuth.isAuthorized()) {
    throw new Error('Google Sheets 尚未授權,請先完成 OAuth 授權');
  }
  
  const auth = googleAuth.getOAuth2Client();
  return google.sheets({ version: 'v4', auth });
}

// ==================== 讀取訂單數據 ====================
async function fetchOrderData() {
  try {
    const sheets = await getGoogleSheetsClient();
    
    // 🔥 方法1: 先嘗試用指定的工作表名稱
    let response;
    try {
      response = await sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${CONFIG.SHEET_NAME}!A:L`,
      });
    } catch (error) {
      // 🔥 方法2: 如果失敗,自動讀取第一個工作表
      console.log('⚠️ 指定的工作表名稱無效,嘗試讀取第一個工作表...');
      
      // 取得所有工作表資訊
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID
      });
      
      const firstSheet = spreadsheet.data.sheets[0];
      const sheetTitle = firstSheet.properties.title;
      
      console.log(`✅ 找到工作表: ${sheetTitle}`);
      
      // 用第一個工作表的名稱重新讀取
      response = await sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${sheetTitle}!A:L`,
      });
    }

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      throw new Error('找不到數據');
    }

    // 跳過標題行,解析訂單數據
    const orders = rows.slice(1).map(row => ({
      date: row[0],           // 日期
      time: row[1],           // 時間
      orderId: row[2],        // 訂單編號
      customerName: row[3],   // 客戶姓名
      phone: row[4],          // 客戶電話
      itemName: row[5],       // 項目名稱
      quantity: parseInt(row[6]) || 1,     // 數量
      unitPrice: parseInt(row[7]) || 0,    // 單價
      subtotal: parseInt(row[8]) || 0,     // 小計
      orderTotal: parseInt(row[9]) || 0,   // 訂單總額
      paymentMethod: row[10], // 付款方式
      deliveryMethod: row[11] // 配送方式
    }));

    return orders;
  } catch (error) {
    console.error('讀取訂單數據失敗:', error);
    throw error;
  }
}

// ==================== 數據分析引擎 ====================
function analyzeHistoricalData(orders) {
  // 按日期分組統計
  const dailyStats = {};
  const weekdayStats = Array(7).fill(0).map(() => ({ count: 0, revenue: 0, orders: [] }));
  
  orders.forEach(order => {
    const date = order.date;
    const orderDate = new Date(date);
    const weekday = orderDate.getDay(); // 0=週日, 1=週一...
    
    // 每日統計
    if (!dailyStats[date]) {
      dailyStats[date] = {
        orderCount: 0,
        revenue: 0,
        takeMyself: 0,
        deliveryToDoor: 0,
        items: {}
      };
    }
    
    dailyStats[date].orderCount++;
    dailyStats[date].revenue += order.orderTotal;
    
    if (order.deliveryMethod === 'TakeMyself') {
      dailyStats[date].takeMyself++;
    } else if (order.deliveryMethod === 'DeliveryToDoor') {
      dailyStats[date].deliveryToDoor++;
    }
    
    // 項目統計
    if (!dailyStats[date].items[order.itemName]) {
      dailyStats[date].items[order.itemName] = 0;
    }
    dailyStats[date].items[order.itemName]++;
    
    // 星期統計
    weekdayStats[weekday].count++;
    weekdayStats[weekday].revenue += order.orderTotal;
    weekdayStats[weekday].orders.push(order);
  });
  
  return { dailyStats, weekdayStats };
}

// ==================== 預測演算法 ====================
function generateForecast(dailyStats, weekdayStats, forecastDays = 14) {
  const dates = Object.keys(dailyStats).sort();
  const historicalDays = dates.length;
  
  // 計算平均值
  const avgDailyOrders = dates.reduce((sum, date) => sum + dailyStats[date].orderCount, 0) / historicalDays;
  const avgDailyRevenue = dates.reduce((sum, date) => sum + dailyStats[date].revenue, 0) / historicalDays;
  
  // 計算星期效應係數
  const weekdayMultipliers = weekdayStats.map((stat, idx) => {
    const weekdayAvg = stat.count / Math.max(1, Math.floor(historicalDays / 7));
    return weekdayAvg > 0 ? weekdayAvg / avgDailyOrders : 1;
  });
  
  // 生成未來預測
  const forecasts = [];
  const today = new Date();
  
  for (let i = 1; i <= forecastDays; i++) {
    const forecastDate = new Date(today);
    forecastDate.setDate(today.getDate() + i);
    const weekday = forecastDate.getDay();
    
    // 基礎預測 × 星期效應係數
    const predictedOrders = Math.round(avgDailyOrders * weekdayMultipliers[weekday]);
    const predictedRevenue = Math.round(avgDailyRevenue * weekdayMultipliers[weekday]);
    
    // 信心區間 (±20%)
    const orderRange = {
      min: Math.round(predictedOrders * 0.8),
      max: Math.round(predictedOrders * 1.2)
    };
    
    forecasts.push({
      date: forecastDate.toISOString().split('T')[0],
      weekday: ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][weekday],
      predictedOrders,
      orderRange,
      predictedRevenue,
      confidence: historicalDays >= 7 ? 'medium' : 'low'
    });
  }
  
  return forecasts;
}

// ==================== 建議生成 ====================
function generateRecommendations(forecasts, dailyStats, weekdayStats) {
  const recommendations = [];
  
  // 找出最忙的日子
  const busiestDay = forecasts.reduce((max, day) => 
    day.predictedOrders > max.predictedOrders ? day : max
  , forecasts[0]);
  
  if (busiestDay.predictedOrders > forecasts[0].predictedOrders * 1.3) {
    recommendations.push({
      type: 'staffing',
      priority: 'high',
      message: `${busiestDay.date} (${busiestDay.weekday}) 預計特別忙碌 (${busiestDay.predictedOrders}單),建議增加人手或提前準備`
    });
  }
  
  // 計算一週總需求
  const weeklyOrders = forecasts.slice(0, 7).reduce((sum, day) => sum + day.predictedOrders, 0);
  const estimatedDetergent = Math.ceil(weeklyOrders * 0.8); // 假設每單平均用0.8L洗劑
  
  recommendations.push({
    type: 'supplies',
    priority: 'medium',
    message: `未來一週預計 ${weeklyOrders} 單,建議備貨洗劑約 ${estimatedDetergent}L`
  });
  
  // 星期模式建議
  const weekdayAvg = weekdayStats.map((stat, idx) => ({
    day: ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][idx],
    avg: stat.count
  }));
  
  const busiestWeekday = weekdayAvg.reduce((max, day) => day.avg > max.avg ? day : max);
  
  recommendations.push({
    type: 'pattern',
    priority: 'info',
    message: `歷史數據顯示 ${busiestWeekday.day} 通常是最忙的一天`
  });
  
  return recommendations;
}

// ==================== 使用 AI 深度分析 ====================
async function getAIInsights(dailyStats, forecasts, weekdayStats) {
  const historicalSummary = Object.entries(dailyStats).map(([date, stats]) => 
    `${date}: ${stats.orderCount}單, $${stats.revenue}`
  ).join('\n');
  
  const forecastSummary = forecasts.slice(0, 7).map(f => 
    `${f.date} (${f.weekday}): 預測${f.predictedOrders}單`
  ).join('\n');
  
  const prompt = `你是 C.H 精緻洗衣的營運分析顧問。以下是歷史訂單數據和未來預測:

【歷史數據】
${historicalSummary}

【未來7天預測】
${forecastSummary}

請用繁體中文提供:
1. 數據趨勢分析 (2-3句話)
2. 潛在商機或風險提醒 (1-2句話)
3. 具體行動建議 (1-2句話)

請簡潔專業,直接給出洞察,不要客套話。`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('AI分析失敗:', error);
    return '(AI分析暫時無法使用)';
  }
}

// ==================== 計算預測準確度 ====================
function calculateAccuracy(dailyStats) {
  // 這裡會在有足夠歷史預測數據後實作
  // 目前先返回 N/A
  return {
    last7Days: 'N/A',
    last30Days: 'N/A',
    message: '累積更多數據後將顯示準確度'
  };
}

// ==================== 生成 LINE 格式報表 ====================
function generateLINEReport(forecasts, recommendations, aiInsights, accuracy) {
  const today = new Date().toLocaleDateString('zh-TW');
  const todayForecast = forecasts[0];
  
  // 忙碌指數
  const busyLevel = todayForecast.predictedOrders < 30 ? '⭐⭐' :
                    todayForecast.predictedOrders < 45 ? '⭐⭐⭐' :
                    todayForecast.predictedOrders < 60 ? '⭐⭐⭐⭐' : '⭐⭐⭐⭐⭐';
  
  let report = `📊 C.H洗衣 每日需求預測 ${today}\n\n`;
  report += `【今日預測】\n`;
  report += `預計訂單: ${todayForecast.orderRange.min}-${todayForecast.orderRange.max} 單\n`;
  report += `預計營收: $${(todayForecast.predictedRevenue * 0.8).toLocaleString()}-${(todayForecast.predictedRevenue * 1.2).toLocaleString()}\n`;
  report += `忙碌指數: ${busyLevel}\n\n`;
  
  report += `【未來7天趨勢】\n`;
  forecasts.slice(0, 7).forEach((f, idx) => {
    const trend = idx > 0 ? 
      (f.predictedOrders > forecasts[idx-1].predictedOrders ? '⬆️' : 
       f.predictedOrders < forecasts[idx-1].predictedOrders ? '⬇️' : '→') : '';
    report += `${f.weekday} ${f.date.slice(5)}: ${f.predictedOrders}單 ${trend}\n`;
  });
  
  report += `\n【AI 洞察分析】\n${aiInsights}\n\n`;
  
  report += `【本週建議】\n`;
  recommendations.forEach(rec => {
    const icon = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '💡';
    report += `${icon} ${rec.message}\n`;
  });
  
  report += `\n📈 預測準確度: ${accuracy.message}`;
  
  return report;
}

// ==================== 生成 Email HTML 報表 ====================
function generateEmailHTML(forecasts, recommendations, aiInsights, dailyStats, weekdayStats, accuracy) {
  const today = new Date().toLocaleDateString('zh-TW');
  
  // 生成未來7天表格
  const forecastTableRows = forecasts.slice(0, 7).map(f => `
    <tr>
      <td>${f.date}</td>
      <td>${f.weekday}</td>
      <td><strong>${f.predictedOrders}</strong></td>
      <td>${f.orderRange.min} - ${f.orderRange.max}</td>
      <td>$${f.predictedRevenue.toLocaleString()}</td>
    </tr>
  `).join('');
  
  // 生成未來14天表格
  const forecast14TableRows = forecasts.map(f => `
    <tr>
      <td>${f.date}</td>
      <td>${f.weekday}</td>
      <td>${f.predictedOrders}</td>
      <td>$${f.predictedRevenue.toLocaleString()}</td>
    </tr>
  `).join('');
  
  // 歷史數據摘要
  const dates = Object.keys(dailyStats).sort();
  const totalOrders = dates.reduce((sum, date) => sum + dailyStats[date].orderCount, 0);
  const totalRevenue = dates.reduce((sum, date) => sum + dailyStats[date].revenue, 0);
  const avgDaily = Math.round(totalOrders / dates.length);
  
  // 星期分析
  const weekdayAnalysis = weekdayStats.map((stat, idx) => {
    const dayName = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][idx];
    return `<li>${dayName}: 平均 ${Math.round(stat.count / Math.max(1, Math.floor(dates.length / 7)))} 單/天</li>`;
  }).join('');
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, 'Microsoft JhengHei', sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; border-left: 4px solid #3498db; padding-left: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    th { background: #3498db; color: white; padding: 12px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f5f5f5; }
    .summary { background: #ecf0f1; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .recommendation { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 10px 0; }
    .recommendation.high { background: #f8d7da; border-left-color: #dc3545; }
    .ai-insights { background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 20px 0; white-space: pre-line; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #7f8c8d; font-size: 12px; }
  </style>
</head>
<body>
  <h1>📊 C.H 精緻洗衣 - 需求預測報表</h1>
  <p><strong>報表日期:</strong> ${today}</p>
  
  <div class="summary">
    <h3>📈 歷史數據摘要 (累積 ${dates.length} 天)</h3>
    <ul>
      <li><strong>總訂單數:</strong> ${totalOrders} 單</li>
      <li><strong>總營收:</strong> $${totalRevenue.toLocaleString()}</li>
      <li><strong>日均訂單:</strong> ${avgDaily} 單</li>
      <li><strong>日均營收:</strong> $${Math.round(totalRevenue / dates.length).toLocaleString()}</li>
    </ul>
  </div>
  
  <h2>🔮 未來 7 天詳細預測</h2>
  <table>
    <thead>
      <tr>
        <th>日期</th>
        <th>星期</th>
        <th>預測訂單</th>
        <th>信心區間</th>
        <th>預測營收</th>
      </tr>
    </thead>
    <tbody>
      ${forecastTableRows}
    </tbody>
  </table>
  
  <h2>📅 未來 14 天趨勢</h2>
  <table>
    <thead>
      <tr>
        <th>日期</th>
        <th>星期</th>
        <th>預測訂單</th>
        <th>預測營收</th>
      </tr>
    </thead>
    <tbody>
      ${forecast14TableRows}
    </tbody>
  </table>
  
  <div class="ai-insights">
    <h3>🤖 AI 深度分析</h3>
    ${aiInsights}
  </div>
  
  <h2>💡 營運建議</h2>
  ${recommendations.map(rec => `
    <div class="recommendation ${rec.priority}">
      <strong>${rec.type === 'staffing' ? '👥 人力配置' : rec.type === 'supplies' ? '📦 物料備貨' : '📊 營運模式'}:</strong>
      ${rec.message}
    </div>
  `).join('')}
  
  <h2>📊 星期效應分析</h2>
  <ul>
    ${weekdayAnalysis}
  </ul>
  
  <div class="summary">
    <h3>🎯 預測準確度追蹤</h3>
    <p>${accuracy.message}</p>
  </div>
  
  <div class="footer">
    <p>本報表由 C.H 洗衣智能預測系統自動生成</p>
    <p>預測模型會隨著數據累積持續優化,建議每日參考以調整營運策略</p>
  </div>
</body>
</html>
  `;
  
  return html;
}

// ==================== 發送 Email ====================
async function sendEmailReport(htmlContent, textContent) {
  try {
    const transporter = nodemailer.createTransport(CONFIG.SMTP);
    
    const mailOptions = {
      from: `C.H洗衣預測系統 <${CONFIG.SMTP.auth.user}>`,
      to: CONFIG.EMAIL_TO,
      subject: `📊 C.H洗衣需求預測報表 - ${new Date().toLocaleDateString('zh-TW')}`,
      text: textContent,
      html: htmlContent
    };
    
    await transporter.sendMail(mailOptions);
    console.log('✅ Email 報表已發送');
  } catch (error) {
    console.error('❌ Email 發送失敗:', error);
    throw error;
  }
}

// ==================== 主程式 ====================
async function main() {
  try {
    console.log('🚀 開始生成需求預測報表...');
    
    // 1. 讀取訂單數據
    console.log('📥 讀取訂單數據...');
    const orders = await fetchOrderData();
    console.log(`✅ 讀取了 ${orders.length} 筆訂單記錄`);
    
    // 2. 分析歷史數據
    console.log('📊 分析歷史數據...');
    const { dailyStats, weekdayStats } = analyzeHistoricalData(orders);
    
    // 3. 生成預測
    console.log('🔮 生成未來預測...');
    const forecasts = generateForecast(dailyStats, weekdayStats, CONFIG.FORECAST_DAYS);
    
    // 4. 生成建議
    console.log('💡 生成營運建議...');
    const recommendations = generateRecommendations(forecasts, dailyStats, weekdayStats);
    
    // 5. AI 深度分析
    console.log('🤖 進行 AI 深度分析...');
    const aiInsights = await getAIInsights(dailyStats, forecasts, weekdayStats);
    
    // 6. 計算準確度
    const accuracy = calculateAccuracy(dailyStats);
    
    // 7. 生成報表
    console.log('📝 生成報表...');
    const lineReport = generateLINEReport(forecasts, recommendations, aiInsights, accuracy);
    const emailHTML = generateEmailHTML(forecasts, recommendations, aiInsights, dailyStats, weekdayStats, accuracy);
    
    // 8. 發送報表
    console.log('📧 發送 Email 報表...');
    await sendEmailReport(emailHTML, lineReport);
    
    // 9. 輸出 LINE 報表內容 (可整合到你現有的 LINE 推播系統)
    console.log('\n' + '='.repeat(50));
    console.log('📱 LINE 報表內容:');
    console.log('='.repeat(50));
    console.log(lineReport);
    console.log('='.repeat(50));
    
    console.log('\n✅ 需求預測報表生成完成!');
    
    return {
      success: true,
      lineReport,
      forecasts,
      recommendations
    };
    
  } catch (error) {
    console.error('❌ 生成報表失敗:', error);
    throw error;
  }
}

// 如果直接執行此檔案
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

// 匯出供其他模組使用
module.exports = {
  main,
  fetchOrderData,
  analyzeHistoricalData,
  generateForecast,
  generateRecommendations,
  getAIInsights
};
