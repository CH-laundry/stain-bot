const { OpenAI } = require('openai');

// 初始化 OpenAI 客户端
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * 智能污渍分析服务
 * @param {Buffer} imageBuffer - 图片buffer
 * @returns {Promise<string>} 分析结果
 */
async function analyzeStainWithAI(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');

    const openaiResponse = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
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
        }, {
            role: 'user',
            content: [
                { type: 'text', text: '請分析此物品並提供專業清潔建議。' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
            ]
        }]
    });

    // 处理分析结果
    let analysisResult = openaiResponse.choices[0].message.content
        .replace(/\*\*/g, '')
        .replace(/我們會以不傷害材質盡量做清潔處理。/g, '');

    // 确保结尾格式统一
    if (!analysisResult.endsWith('確保最佳效果。')) {
        analysisResult += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
    }

    return analysisResult;
}

/**
 * AI客服回应服务
 * @param {string} text - 用户输入文本
 * @returns {Promise<string>} AI回应内容
 */
async function getAIResponse(text) {
    const aiResponse = await openaiClient.chat.completions.create({
        model: 'gpt-4',
        messages: [{
            role: 'system',
            content: `你是 C.H 精緻洗衣的客服人員，請使用自然、親切的口語化中文回應客戶提問，並遵守以下規則：
1. 回覆時結尾請加一個合適的表情符號（如 😊、👍、🧺 等）
2. 禁用過度專業術語，要讓一般人一聽就懂
3. 不要主動提及確切天數，但可以用模糊說法如「通常當天或隔天會收回唷 😊」
4. 請以 C.H 精緻洗衣的立場回答，避免胡亂推測
5. 客戶的問題只要與以下主題相關，都請主動回應：
   - 衣物、鞋子、包包的清洗、材質、是否會洗壞
   - 收衣流程、送衣時間、洗完怎麼通知
   - 上門收送（例如：你們會來收衣嗎？可以送來嗎？）
   - 清洗過程、洗不洗得掉、怎麼處理汙漬
6. 當客戶問「會洗壞嗎？」等擔憂問題時，請溫和回應：
   -「我們都會根據材質與狀況判斷，清洗前也會特別評估風險唷 😊」
7. 收衣服方面：可以說明我們有提供到府收送服務，通常當天或隔天會收，週六固定公休唷
8. 若無法明確回答，可這樣回：「這個部分我們會幫您再確認一下唷 😊」
9. 如果客戶只是打招呼或講與洗衣無關的話（如：你好、謝謝、按錯了），可以不回應`

            role: 'user',
            content: text
        }]
    });

    return aiResponse.choices[0].message.content;
}

module.exports = {
    analyzeStainWithAI,
    getAIResponse
};
