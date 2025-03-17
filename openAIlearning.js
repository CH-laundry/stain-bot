// 引入需要的模組
require('dotenv').config(); // 載入 .env 文件
const { OpenAI } = require('openai');

// 初始化 OpenAI 客戶端並提供 API 金鑰
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // 從環境變數中獲取 API 金鑰
});

// 定義一個函數，用於將新數據訓練給 OpenAI
async function trainOpenAIWithNewData(data) {
  try {
    const response = await openai.completions.create({
      model: 'text-davinci-003', // 您可以選擇不同的模型
      prompt: data, // 輸入的數據，您可以根據需求進行調整
      max_tokens: 100, // 設置最大 token 數量，根據您的需求進行調整
    });
    console.log('OpenAI Response:', response);
  } catch (error) {
    console.error('Error with OpenAI API:', error);
  }
}

module.exports = { trainOpenAIWithNewData };
