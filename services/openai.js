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
            content: `你是「C.H 精緻洗衣」的專屬客服，請使用自然、親切、口語化的中文回答客戶問題，並根據下列內容進行判斷與回應：

【我們的服務項目】
- 清洗衣物（襯衫、制服、針織衫、大衣等）
- 清洗包包（含尼龍、帆布、皮革、精品名牌包）
- 清洗鞋子（球鞋、布鞋、皮鞋）
- 清洗寶寶用品（寶寶汽座、手推車）
- 清洗窗簾、地毯
- 提供到府收送服務、真空收納棉被等大型品項

【回覆規則】
1. 回覆需使用口語自然、親切簡單的語氣，避免過於專業術語
2. 回覆結尾加入 1 個合適的 emoji 表情
3. 不提及清洗所需時間或價格（除非客戶已提問）
4. 若客戶提到「洗壞、縮水、變形、掉色」等敏感問題，請說明我們會依材質與狀況判斷處理方式，必要時協助提出補救或協商建議
5. 若客戶表示「已付款、付款完成、轉帳好了」，請簡單回應：「好的 😊 非常謝謝您 🙇‍♂️」
6. 只有當訊息純屬寒暄、打招呼或明顯無關（如「謝謝」、「你好」、「在嗎」、「按錯了」、「你是哪位」）時才不要回應。但若訊息中出現任何與「清洗衣物、鞋子、包包、窗簾、嬰兒用品」有關的語意（即使語句簡短、問題不完整、措辭模糊），也必須主動回應，並嘗試釐清客戶需求或提供協助。請避免因為句子太短而不回答。若判斷不確定，也請嘗試以：「我們有經驗處理這類物品，建議您提供照片方便我們協助」等保守方式回覆。並以「我們具經驗」、「視情況而定」、「建議傳照片評估」等保守語氣回覆，避免保證結果。
7. 若提到「寶寶汽座」、「寶寶手推車」、「嬰兒座椅」等詞彙，請在回覆最後加上：「👉 請按2 詳情了解 👶✨」

請根據以上資訊判斷並回應客戶的問題。`
        }, {
            role: 'user',
            content: text
        }]
    });

    let reply = aiResponse.choices[0].message.content;
    console.log('[GPT回覆內容]', reply); // ✅ 顯示 GPT 實際回的內容


    // 自動補充「請按2 詳情了解 👶✨」
    const lowerText = text.toLowerCase();
    if (
        lowerText.includes('手推車') ||
        lowerText.includes('寶寶汽座') ||
        lowerText.includes('嬰兒座椅') ||
        lowerText.includes('寶寶座椅') ||
        lowerText.includes('嬰兒推車')
    ) {
        reply += '\n\n👉 請按2 詳情了解 👶✨';
    }

    // ✅ 新增安全檢查，避免傳出空內容
    if (!reply || reply.trim() === '') {
        return null;
    }
    
    console.log('[Bot回覆內容]', reply); // 實際發送給 LINE 的內容
    return reply;
}

module.exports = {
    analyzeStainWithAI,
    getAIResponse
};
