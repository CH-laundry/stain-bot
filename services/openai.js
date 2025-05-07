const { OpenAI } = require('openai');
const { google } = require('googleapis');
const path = require('path');

// ✅ 初始化 OpenAI 客戶端
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ✅ Google Sheets 記錄功能
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_CREDS || path.join(__dirname, '../sheet.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET_NAME = '使用者提問紀錄'; // ✅ 對應你給的 Google Sheets 工作表名稱

// ✅ 回應後自動記錄
async function logLearningEntry(question, answer) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const row = [question, answer, 'AI生成', timestamp];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:D`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
        });

        console.log('✅ 已寫入學習表：', question);
    } catch (err) {
        console.error('❌ 寫入學習表失敗：', err.message);
    }
}

// ✅ AI 客服回應
async function getAIResponse(text) {
    const res = await openaiClient.chat.completions.create({
        model: 'gpt-4',
        messages: [
            {
                role: 'system',
                content: `你是 C.H 精緻洗衣的客服人員，請使用自然、親切的口語化中文回應客戶提問，並遵守以下規則：

1. 回覆時結尾請加一個合適的表情符號（如 😊、👍、🧺 等）
2. 禁用過度專業術語，要讓一般人一聽就懂
3. 不要主動提及確切天數，但可以用模糊說法如「通常當天或隔天會收回唷 😊」
4. 請以 C.H 精緻洗衣的立場回答，避免胡亂推測
5. 客戶的問題只要與以下主題相關，都請主動回應：
   - 衣物、鞋子、包包的清洗、材質、是否會洗壞
   - 收衣流程、送衣時間、洗完怎麼通知
   - 上門收送、付款方式、價格詢問
6. 客人若問「會洗壞嗎？」要回：「我們會依材質與狀況判斷並特別評估唷 😊」
7. 如果無法明確回答，可以說：「這個部分我們會幫您再確認一下唷 😊」
8. 如果客戶只是說「謝謝」、「你好」、「按錯了」，請不需要回覆`
            },
            {
                role: 'user',
                content: text
            }
        ]
    });

    const reply = res.choices[0].message.content;
    if (reply) {
        await logLearningEntry(text, reply);
    }

    return reply;
}

// ✅ 污漬圖片分析功能
async function analyzeStainWithAI(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');

    const res = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            {
                role: 'system',
                content: `你是專業的精品清潔顧問，請按照以下格式分析圖片：
1. 以流暢口語化中文描述物品與污漬狀況
2. 清洗成功機率（精確百分比）
3. 品牌辨識（使用「可能為」、「推測為」等專業用語）
4. 材質分析（說明材質特性與清潔注意點）
5. 款式特徵（專業術語描述設計元素）
6. 若為精品包（如 Louis Vuitton、Chanel、Hermès 等），請提供年份與稀有性資訊（若可辨識）
7. 結尾統一使用：「我們會根據材質特性進行適當清潔，確保最佳效果。」`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '請分析此物品並提供專業建議。' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                ]
            }
        ]
    });

    let result = res.choices[0].message.content;
    if (!result.endsWith('確保最佳效果。')) {
        result += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }

    return result;
}

module.exports = {
    getAIResponse,
    analyzeStainWithAI
};
