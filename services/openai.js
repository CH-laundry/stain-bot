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
            content: '你是一個洗衣店客服，回答需滿足：1.用口語化中文 2.結尾加1個表情 3.禁用專業術語 4.不提及時間長短 5.無法回答時不回應。如果訊息與洗衣店無關（如「謝謝」、「您好」、「按錯」等），請不要回應。'
        }, {
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
