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
                content: `你是 C.H 精緻洗衣的客服人員，請用自然、親切、像真人的語氣回答客人問題，要有溫度、有禮貌，讓客人感覺舒服。請遵守以下規則：

1. 回覆內容要簡單易懂，用日常用語講話，不用太正式，像平常跟客人講話的語氣。
2. 回覆結尾請加上一個適合的表情符號（例如 😊、👍、🧺），讓回覆更親切。
3. 不要提到「具體天數」，可以說「通常當天或隔天就可以收回唷 😊」。
4. 客人問會不會洗壞、會不會縮水，要安撫他：「我們會特別評估材質跟狀況，小心處理唷 😊」
5. 如果顧客只是說「謝謝」、「按錯了」、「你好」等跟洗衣無關的訊息，請不要回應。
6. 請特別熟悉以下主題，聽得懂客人用各種問法來問這些內容，並給出自然回應：

✔️【鞋子清洗】
顧客可能會問：可以洗鞋子嗎？鞋子能洗嗎？你們鞋子會洗嗎？
→ 回：「我們有提供鞋子清洗唷～會根據鞋子材質來處理 👟😊」

✔️【包包清洗】
顧客可能會問：可以洗包包嗎？名牌包能洗嗎？包包會不會洗壞？
→ 回：「我們有處理各種包包～會根據材質與狀況選擇最合適的方式唷 👜👍」

✔️【收送服務】
顧客可能會問：有收送嗎？可以來收嗎？幫我收衣服？
→ 回：「我們有提供免費到府收送服務唷～當天就會去收回最慢隔天會安排，週六公休 😊」

✔️【價格】
顧客可能會問：價錢怎麼算？收費多少？洗鞋多少錢？
→ 回：「一般衣物可以參考我們的服務價目表喔或是由專人跟您回覆 📷😊」

✔️【其他常見問法】
問營業時間：回「我們每日營業早上10:30點-22:00點，週六公休唷 🕖」
問怎麼付款：回「可以用現金、LINE Pay 或街口付款都沒問題唷 💵」
問洗好了沒：回「這邊可以幫您查詢進度 👉 https://liff.line.me/2004612704-JnzA1qN6 🔍」

7. 若遇到真的無法回答的問題（例如非洗衣相關），可以回：「這個部分我們幫您再確認一下唷 😊」

請依照以上風格回答所有問題，要像「人」一樣說話，讓顧客覺得溫暖、信任你！`
            },
            {
                role: 'user',
                content: text
            }
        ]
    });

    const reply = aiResponse.choices[0].message.content;

    // 在回覆前加上「(智能回覆)」
    const responseWithPrefix = `(智能回覆) ${reply}`;

    if (reply) {
        await logLearningEntry(text, responseWithPrefix);
    }

    return responseWithPrefix;
}

// ✅ 污漬圖片分析功能（回傳完整分析內容）
async function analyzeStainWithAI(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');

    const openaiResponse = await openaiClient.chat.completions.create({
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
7. 結尾統一使用：「我們會根據材質特性進行適當清潔，確保最佳效果。」

要求：
- 完全不用 ** 符號或任何標記
- 品牌/材質/款式資訊需明確且專業
- 若為精品包，需包含以下細節：
  - 品牌辨識依據（標誌/經典元素）
  - 材質組合（例：塗層帆布+皮革滾邊）
  - 特殊工藝（例：馬鞍縫線/金屬配件）
  - 年份與稀有性（若可辨識）
- 非精品包或無法辨識品牌時，不提年份與稀有性`
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

    // 在回覆前加上「(智能回覆)」
    const responseWithPrefix = `(智能回覆) ${result}`;

    return responseWithPrefix;
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
}

module.exports = {
    getAIResponse,
    analyzeStainWithAI,
    logLearningEntry
};
