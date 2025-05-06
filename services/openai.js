const { OpenAI } = require('openai');
const { google } = require("googleapis");
const path = require("path");

// 初始化 OpenAI 客戶端
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ✅ GPT AI 客服回覆（自然語氣 + 表情符號 + 擬人化語意強化）
async function getAIResponse(text) {
    const aiResponse = await openaiClient.chat.completions.create({
        model: 'gpt-4',
        messages: [
            {
                role: 'system',
                content: `你是 C.H 精緻洗衣的客服人員...（保持原樣不變）`
            },
            {
                role: 'user',
                content: text
            }
        ]
    });

    const reply = aiResponse.choices[0].message.content;
    if (reply) {
        await logLearningEntry(text, reply);
    }

    return reply;
}

// ✅ 污漬圖片分析功能（回傳完整分析內容）
async function analyzeStainWithAI(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');

    const openaiResponse = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            {
                role: 'system',
                content: `你是專業的精品清潔顧問...（保持原樣不變）`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '請分析此物品並提供專業清潔建議。' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                ]
            }
        ]
    });

    let result = openaiResponse.choices[0].message.content;
    if (!result.endsWith('確保最佳效果。')) {
        result += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }

    return result;
}

// ✅ 回答成功 → 自動記錄學習資料到 Google Sheets
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "../applied-pager-449804-c6-a6aa3340d8da.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const SPREADSHEET_ID = "1Cfavtl8HGpQDeibPi-qeUOqbfuFKTM68kUAjR6uQYVI";
const SHEET_NAME = "工作表1";

async function logLearningEntry(question, answer) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: "v4", auth: client });

        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const row = [question, answer, "AI生成", timestamp];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:D`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [row] }
        });

        console.log("✅ 已寫入學習表：", question);
    } catch (error) {
        console.error("❌ 學習記錄寫入失敗：", error.message);
    }
}  // <--- 這裡原本多了一個 ); 已移除

// ✅ 匯出模組
module.exports = {
    getAIResponse,
    analyzeStainWithAI,
    logLearningEntry
};
