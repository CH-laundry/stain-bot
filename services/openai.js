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

/**
 * 智能污漬分析服務
 * @param {Buffer} imageBuffer - 圖片 Buffer (污漬物品的照片)
 * @param {string} [materialInfo] - 可選，衣物材質描述
 * @param {Buffer} [labelImageBuffer] - 可選，洗滌標籤圖片 Buffer
 * @returns {Promise<string>} 分析結果（包含 AI 分析內容和護理建議兩段）
 */
async function analyzeStainWithAI(imageBuffer, materialInfo = '', labelImageBuffer = null) {
    const base64Image = imageBuffer.toString('base64');
    let base64Label = '';
    if (labelImageBuffer) {
        base64Label = labelImageBuffer.toString('base64');
    }

    // 構造使用者消息內容
    const userContent = [];
    userContent.push({ type: 'text', text: '請分析此物品並提供專業清潔建議。' });
    if (materialInfo) {
        userContent.push({ type: 'text', text: `衣物材質：${materialInfo}` });
    }
    // 主體物品圖片
    userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } });
    if (base64Label) {
        // 提示洗滌標籤資訊並附加洗標圖片
        userContent.push({ type: 'text', text: '以下是該物品的洗滌標籤資訊，請一併參考。' });
        userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Label}` } });
    }

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
7. 在分析部分結尾使用：「我們會根據材質特性進行適當清潔，確保最佳效果。」
8. 之後在新段落提供護理建議（根據材質和款式給出日常維護建議）`
            },
            {
                role: 'user',
                content: userContent
            }
        ]
    });

    // 取得並處理分析結果文本
    let analysisResult = openaiResponse.choices[0].message.content;
    // 移除不需要的符號或舊格式內容
    analysisResult = analysisResult.replace(/\*\*/g, '');  // 移除 ** 符號
    analysisResult = analysisResult.replace(/我們會以不傷害材質盡量做清潔處理。/g, '');  // 移除舊版結尾語句

    // 確保輸出包含標準結尾和護理建議段落
    if (analysisResult.includes('護理建議')) {
        // 存在護理建議段落
        if (!analysisResult.includes('確保最佳效果。')) {
            // 若缺少標準結尾語句，插入它再換行至護理建議
            analysisResult = analysisResult.replace('護理建議', `我們會根據材質特性進行適當清潔，確保最佳效果。\n\n護理建議`);
        } else {
            // 確保標準結尾語句與護理建議段落間有空行
            analysisResult = analysisResult.replace(/確保最佳效果。(\s*)護理建議/, '確保最佳效果。\n\n護理建議');
        }
    } else {
        // 理論上不會發生：無護理建議則添加標準結尾
        if (!analysisResult.endsWith('確保最佳效果。')) {
            analysisResult += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
        }
    }

    return analysisResult;
}

/**
 * AI客服回應服務
 * @param {string} text - 使用者輸入的文字
 * @returns {Promise<string>} AI 回應內容
 */
async function getAIResponse(text) {
    const aiResponse = await openaiClient.chat.completions.create({
        model: 'gpt-4',
        messages: [
            {
                role: 'system',
                content: '你是一個洗衣店客服，回答需滿足：1. 用口語化中文 2. 結尾加1個表情符號 3. 禁用專業術語 4. 不提及時間長短 5. 無法回答時不回應。如果訊息與洗衣店無關（如「謝謝」、「您好」、「按錯」等），請不要回應。'
            },
            {
                role: 'user',
                content: text
            }
        ]
    });

    return aiResponse.choices[0].message.content;
}

module.exports = {
    analyzeStainWithAI,
    getAIResponse
};
