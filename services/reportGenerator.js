// ====================================
// 週報生成器
// ====================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

// 生成優化建議
async function generateSuggestions(analysis) {
  try {
    const prompt = `你是 C.H 精緻洗衣的 AI 客服顧問。請根據以下本週數據，提供 3 個具體的優化建議：

【本週統計】
- 總對話數：${analysis.totalChats} 則
- 客訴數量：${analysis.complaints} 則
- 不耐煩：${analysis.impatient} 則

【高頻問題】
${analysis.topQuestions.map((q, i) => `${i + 1}. ${q.type}（${q.count} 次）`).join('\n')}

【客訴案例】
${analysis.complaintCases.slice(0, 3).map((c, i) => `
案例 ${i + 1}：
客人：「${c.userMsg}」
AI 回：「${c.aiReply}」
`).join('\n')}

請提供 3 個具體、可執行的優化建議，每個建議包含：
1. 問題描述
2. 具體改進方向
3. 預期效果

請用繁體中文，簡潔專業的語氣回答。`;

    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    return message.content[0].text;

  } catch (error) {
    console.error('生成建議失敗:', error);
    return '建議生成失敗，請手動檢查對話記錄。';
  }
}

// 格式化完整報告
function formatReport(analysis, suggestions) {
  const dateRange = getWeekRange();
  
  let report = `📊 C.H 精緻洗衣 AI 客服週報\n${dateRange}\n\n`;
  
  report += `━━━━━━━━━━━━━━━\n`;
  report += `【本週統計】\n`;
  report += `━━━━━━━━━━━━━━━\n`;
  report += `📈 總對話數：${analysis.totalChats} 則\n`;
  report += `😤 客訴：${analysis.complaints} 則\n`;
  report += `😤 不耐煩：${analysis.impatient} 則\n`;
  report += `😊 正常：${analysis.normal} 則\n\n`;

  report += `━━━━━━━━━━━━━━━\n`;
  report += `【高頻問題 TOP 5】\n`;
  report += `━━━━━━━━━━━━━━━\n`;
  analysis.topQuestions.forEach((q, i) => {
    const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i];
    report += `${emoji} ${q.type}（${q.count} 次，${q.percentage}%）\n`;
  });
  report += `\n`;

  if (analysis.complaintCases.length > 0) {
    report += `━━━━━━━━━━━━━━━\n`;
    report += `【需要關注的對話】\n`;
    report += `━━━━━━━━━━━━━━━\n\n`;
    
    analysis.complaintCases.slice(0, 3).forEach((c, i) => {
      report += `❌ 客訴案例 #${i + 1}\n`;
      report += `時間：${c.date} ${c.time}\n`;
      report += `客人：「${c.userMsg}」\n`;
      report += `AI 回：「${c.aiReply.substring(0, 50)}...」\n`;
      report += `情緒：${c.emotion}\n\n`;
    });
  }

  report += `━━━━━━━━━━━━━━━\n`;
  report += `【AI 優化建議】\n`;
  report += `━━━━━━━━━━━━━━━\n\n`;
  report += suggestions;
  report += `\n\n━━━━━━━━━━━━━━━\n`;
  report += `報告生成時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n`;
  report += `下次報告：下週日 20:00`;

  return report;
}

// 取得本週日期範圍
function getWeekRange() {
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const format = (date) => {
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  };
  
  return `${format(sevenDaysAgo)} - ${format(today)}`;
}

module.exports = {
  generateSuggestions,
  formatReport
};
