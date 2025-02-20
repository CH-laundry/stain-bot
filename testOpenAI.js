const { OpenAI } = require('openai'); // 引入 OpenAI SDK
require('dotenv').config(); // 使用 .env 文件

// 设置 OpenAI 客户端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function testOpenAI() {
  try {
    // 调用 OpenAI API 测试
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: '你好，GPT!' }],
    });
    console.log('OpenAI Response:', response);
  } catch (error) {
    console.error('Error:', error);
  }
}

testOpenAI();
