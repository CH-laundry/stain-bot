const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config();

// 终极字符过滤器
const sanitizeHeader = (value) => {
  return value.toString()
    .replace(/[^\x20-\x7E]/g, '') // 仅允许可打印 ASCII
    .trim();
};

// 环境变量加载后立即调试
console.log("[调试] 原始环境变量:", {
  LINE_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN ? '存在' : '缺失',
  OPENAI_KEY: process.env.OPENAI_API_KEY ? '存在' : '缺失'
});

const config = {
  channelAccessToken: sanitizeHeader(process.env.LINE_CHANNEL_ACCESS_TOKEN || ''),
  channelSecret: sanitizeHeader(process.env.LINE_CHANNEL_SECRET || '')
};

// 致命错误检查
if (!config.channelAccessToken) {
  console.error("致命错误：LINE_TOKEN 无效，十六进制值:", Buffer.from(process.env.LINE_CHANNEL_ACCESS_TOKEN || '').toString('hex'));
  process.exit(1);
}

const client = new line.Client(config); // LINE 客户端实例

const app = express();

// 中间件处理 LINE 请求
app.use(express.json()); // 解析 JSON 请求体

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  
  // 如果有事件
  if (events && events.length > 0) {
    const event = events[0];
    
    // 只处理消息类型事件
    if (event.type === 'message' && event.message.type === 'text') {
      const replyToken = event.replyToken;
      const userMessage = event.message.text;
      
      // 发送回用户的消息
      try {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `你发送了: ${userMessage}`
        });
        console.log('消息已发送');
      } catch (err) {
        console.error('发送消息失败:', err);
      }
    }
  }
  
  res.sendStatus(200); // 返回 200 OK
});

app.listen(3000, () => console.log("运行中，监听端口 3000"));
