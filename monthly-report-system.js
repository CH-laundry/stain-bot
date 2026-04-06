const { google } = require('googleapis');
const { OpenAI } = require('openai');

// ==================== 設定區 ====================
const CONFIG = {
  SPREADSHEET_ID: process.env.GOOGLE_SHEETS_ID_CUSTOMER,
  SHEET_NAME: null,
  EMAIL_TO: 'todayeasy2002@gmail.com',
  SENDGRID: {
    apiKey: process.env.SENDGRID_API_KEY,
    fromEmail: 'todayeasy2002@gmail.com',
    fromName: 'C.H洗衣月度報告系統'
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==================== Google Sheets 連接 ====================
async function getGoogleSheetsClient() {
  const googleAuth = require('./services/googleAuth');
  
  if (!googleAuth.isAuthorized()) {
    throw new Error('Google Sheets 尚未授權');
  }
  
  const auth = googleAuth.getOAuth2Client();
  return google.sheets({ version: 'v4', auth });
}

// ==================== 讀取訂單數據 ====================
async function fetchOrderData() {
  try {
    const sheets = await getGoogleSheetsClient();
    
    console.log('📥 正在讀取營業紀錄...');
    
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID
    });
    
    let targetSheet = spreadsheet.data.sheets.find(
      sheet => sheet.properties.sheetId === 756780563
    );
    
    if (!targetSheet) {
      targetSheet = spreadsheet.data.sheets[0];
    }
    
    const sheetTitle = targetSheet.properties.title;
    console.log(`✅ 找到工作表: ${sheetTitle}`);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `'${sheetTitle}'!A:I`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      throw new Error('找不到數據');
    }

    const orders = rows.slice(1)
      .filter(row => row[0] && row[8])
      .map(row => {
        const dateStr = row[0] || '';
        const totalAmount = parseInt(String(row[8]).replace(/[^0-9]/g, '')) || 0;
        
        return {
          date: dateStr,
          customerName: row[1] || '未知',
          itemName: row[5] || '洗衣服務',
          amount: totalAmount
        };
      });

    console.log(`✅ 成功解析 ${orders.length} 筆有效訂單`);
    return orders;
  } catch (error) {
    console.error('讀取訂單數據失敗:', error);
    throw error;
  }
}

// ==================== 分析月度數據 ====================
function analyzeMonthlyData(orders) {
 const now = new Date();
// 月報報告「上個月」，對比「上上個月」
const reportDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const compareDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
const thisMonth = `${reportDate.getFullYear()}-${String(reportDate.getMonth() + 1).padStart(2, '0')}`;
const lastMonth = `${compareDate.getFullYear()}-${String(compareDate.getMonth() + 1).padStart(2, '0')}`;
  
// 本月數據
  const thisMonthOrders = orders.filter(o => o.date.replace(/\//g, '-').startsWith(thisMonth));
  const thisMonthRevenue = thisMonthOrders.reduce((sum, o) => sum + o.amount, 0);
  const thisMonthCount = thisMonthOrders.length;
  const thisMonthAvgOrder = thisMonthCount > 0 ? Math.round(thisMonthRevenue / thisMonthCount) : 0;
  
  // 上月數據
  const lastMonthOrders = orders.filter(o => o.date.replace(/\//g, '-').startsWith(lastMonth));
  const lastMonthRevenue = lastMonthOrders.reduce((sum, o) => sum + o.amount, 0);
  const lastMonthCount = lastMonthOrders.length;
  const lastMonthAvgOrder = lastMonthCount > 0 ? Math.round(lastMonthRevenue / lastMonthCount) : 0;
  
  // 成長率
  const revenueGrowth = lastMonthRevenue > 0 
    ? Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) 
    : 0;
  const orderGrowth = lastMonthCount > 0 
    ? Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100) 
    : 0;
  const avgOrderGrowth = lastMonthAvgOrder > 0 
    ? Math.round(((thisMonthAvgOrder - lastMonthAvgOrder) / lastMonthAvgOrder) * 100) 
    : 0;
  
  return {
    thisMonth: {
      period: thisMonth,
      revenue: thisMonthRevenue,
      orderCount: thisMonthCount,
      avgOrder: thisMonthAvgOrder
    },
    lastMonth: {
      period: lastMonth,
      revenue: lastMonthRevenue,
      orderCount: lastMonthCount,
      avgOrder: lastMonthAvgOrder
    },
    growth: {
      revenue: revenueGrowth,
      orderCount: orderGrowth,
      avgOrder: avgOrderGrowth
    }
  };
}

// ==================== AI 分析建議 ====================
async function getAIInsights(analysis) {
  const prompt = `你是 C.H 精緻洗衣的營運顧問。以下是月度營收數據:

【本月數據】
營收: $${analysis.thisMonth.revenue.toLocaleString()}
訂單數: ${analysis.thisMonth.orderCount} 單
客單價: $${analysis.thisMonth.avgOrder}

【上月數據】
營收: $${analysis.lastMonth.revenue.toLocaleString()}
訂單數: ${analysis.lastMonth.orderCount} 單
客單價: $${analysis.lastMonth.avgOrder}

【成長率】
營收: ${analysis.growth.revenue}%
訂單數: ${analysis.growth.orderCount}%
客單價: ${analysis.growth.avgOrder}%

請用繁體中文提供:
1. 月度表現評價 (2-3句話)
2. 主要成長/衰退原因分析 (2-3句話)
3. 下個月行動建議 (2-3句話)

請簡潔專業,直接給出洞察。`;

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

// ==================== 生成 LINE 報表 ====================
function generateLINEReport(analysis, aiInsights) {
  const getIcon = (value) => value > 0 ? '⬆️' : value < 0 ? '⬇️' : '→';
  const getEmoji = (value) => value > 5 ? '🎉' : value > 0 ? '✅' : value > -5 ? '⚠️' : '🔴';
  
  let report = `📊 C.H洗衣 月度營收報告\n`;
  report += `📅 ${analysis.thisMonth.period} vs ${analysis.lastMonth.period}\n\n`;
  
  report += `【本月表現】\n`;
  report += `營收: $${analysis.thisMonth.revenue.toLocaleString()} ${getIcon(analysis.growth.revenue)} ${Math.abs(analysis.growth.revenue)}% ${getEmoji(analysis.growth.revenue)}\n`;
  report += `訂單: ${analysis.thisMonth.orderCount} 單 ${getIcon(analysis.growth.orderCount)} ${Math.abs(analysis.growth.orderCount)}%\n`;
  report += `客單價: $${analysis.thisMonth.avgOrder} ${getIcon(analysis.growth.avgOrder)} ${Math.abs(analysis.growth.avgOrder)}%\n\n`;
  
  report += `【上月數據】\n`;
  report += `營收: $${analysis.lastMonth.revenue.toLocaleString()}\n`;
  report += `訂單: ${analysis.lastMonth.orderCount} 單\n`;
  report += `客單價: $${analysis.lastMonth.avgOrder}\n\n`;
  
  report += `【AI 深度分析】\n${aiInsights}\n\n`;
  
  // 總結
  if (analysis.growth.revenue > 10) {
    report += `🎉 營收大幅成長!繼續保持!`;
  } else if (analysis.growth.revenue > 0) {
    report += `✅ 營收穩定成長,持續優化服務`;
  } else if (analysis.growth.revenue > -10) {
    report += `⚠️ 營收小幅下滑,需要關注`;
  } else {
    report += `🔴 營收明顯下滑,建議檢討策略`;
  }
  
  return report;
}

// ==================== 生成 Email HTML 報表 ====================
function generateEmailHTML(analysis, aiInsights) {
  const getArrow = (value) => value > 0 ? '▲' : value < 0 ? '▼' : '─';
  const getColor = (value) => value > 0 ? '#28a745' : value < 0 ? '#dc3545' : '#6c757d';
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, 'Microsoft JhengHei', sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; margin-top: 30px; border-left: 4px solid #3498db; padding-left: 10px; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
    .metric-card { background: #f8f9fa; border-radius: 8px; padding: 20px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .metric-value { font-size: 32px; font-weight: bold; margin: 10px 0; }
    .metric-label { color: #6c757d; font-size: 14px; }
    .growth { font-size: 18px; font-weight: bold; margin-top: 10px; }
    .ai-insights { background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 20px 0; white-space: pre-line; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    th { background: #3498db; color: white; padding: 12px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>📊 C.H 精緻洗衣 - 月度營收報告</h1>
  <p><strong>報告期間:</strong> ${analysis.thisMonth.period} vs ${analysis.lastMonth.period}</p>
  
  <div class="summary-grid">
    <div class="metric-card">
      <div class="metric-label">本月營收</div>
      <div class="metric-value">$${analysis.thisMonth.revenue.toLocaleString()}</div>
      <div class="growth" style="color: ${getColor(analysis.growth.revenue)}">
        ${getArrow(analysis.growth.revenue)} ${Math.abs(analysis.growth.revenue)}%
      </div>
    </div>
    
    <div class="metric-card">
      <div class="metric-label">本月訂單</div>
      <div class="metric-value">${analysis.thisMonth.orderCount}</div>
      <div class="growth" style="color: ${getColor(analysis.growth.orderCount)}">
        ${getArrow(analysis.growth.orderCount)} ${Math.abs(analysis.growth.orderCount)}%
      </div>
    </div>
    
    <div class="metric-card">
      <div class="metric-label">客單價</div>
      <div class="metric-value">$${analysis.thisMonth.avgOrder}</div>
      <div class="growth" style="color: ${getColor(analysis.growth.avgOrder)}">
        ${getArrow(analysis.growth.avgOrder)} ${Math.abs(analysis.growth.avgOrder)}%
      </div>
    </div>
  </div>
  
  <h2>📈 詳細對比</h2>
  <table>
    <thead>
      <tr>
        <th>項目</th>
        <th>本月 (${analysis.thisMonth.period})</th>
        <th>上月 (${analysis.lastMonth.period})</th>
        <th>成長率</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>營收</strong></td>
        <td>$${analysis.thisMonth.revenue.toLocaleString()}</td>
        <td>$${analysis.lastMonth.revenue.toLocaleString()}</td>
        <td style="color: ${getColor(analysis.growth.revenue)}">${analysis.growth.revenue}%</td>
      </tr>
      <tr>
        <td><strong>訂單數</strong></td>
        <td>${analysis.thisMonth.orderCount} 單</td>
        <td>${analysis.lastMonth.orderCount} 單</td>
        <td style="color: ${getColor(analysis.growth.orderCount)}">${analysis.growth.orderCount}%</td>
      </tr>
      <tr>
        <td><strong>客單價</strong></td>
        <td>$${analysis.thisMonth.avgOrder}</td>
        <td>$${analysis.lastMonth.avgOrder}</td>
        <td style="color: ${getColor(analysis.growth.avgOrder)}">${analysis.growth.avgOrder}%</td>
      </tr>
    </tbody>
  </table>
  
  <div class="ai-insights">
    <h3>🤖 AI 深度分析</h3>
    ${aiInsights}
  </div>
  
  <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #7f8c8d; font-size: 12px;">
    <p>本報表由 C.H 洗衣智能報告系統自動生成</p>
  </div>
</body>
</html>
  `;
  
  return html;
}

// ==================== 發送 Email ====================
async function sendEmailReport(htmlContent, textContent) {
  try {
    console.log('📧 準備發送月度報告 Email...');
    
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(CONFIG.SENDGRID.apiKey);
    
    const msg = {
      to: CONFIG.EMAIL_TO,
      from: {
        email: CONFIG.SENDGRID.fromEmail,
        name: CONFIG.SENDGRID.fromName
      },
      subject: `📊 C.H洗衣月度營收報告 - ${new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' })}`,
      text: textContent,
      html: htmlContent
    };
    
    await sgMail.send(msg);
    console.log('✅ Email 報告已發送');
    
    return { success: true };
  } catch (error) {
    console.error('❌ Email 發送失敗:', error.message);
    return { success: false, error: error.message };
  }
}

// ==================== 主程式 ====================
async function main() {
  try {
    console.log('🚀 開始生成月度營收報告...');
    
    const orders = await fetchOrderData();
    console.log(`✅ 讀取了 ${orders.length} 筆訂單記錄`);
    
    console.log('📊 分析月度數據...');
    const analysis = analyzeMonthlyData(orders);
    
    console.log('🤖 進行 AI 深度分析...');
    const aiInsights = await getAIInsights(analysis);
    
    console.log('📝 生成報表...');
    const lineReport = generateLINEReport(analysis, aiInsights);
    const emailHTML = generateEmailHTML(analysis, aiInsights);
    
    console.log('📧 發送 Email 報表...');
    await sendEmailReport(emailHTML, lineReport);
    
    console.log('\n' + '='.repeat(50));
    console.log('📱 LINE 報表內容:');
    console.log('='.repeat(50));
    console.log(lineReport);
    console.log('='.repeat(50));
    
    console.log('\n✅ 月度營收報告生成完成!');
    
    return {
      success: true,
      lineReport,
      emailHTML,
      analysis
    };
    
  } catch (error) {
    console.error('❌ 生成報表失敗:', error);
    throw error;
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { main };
