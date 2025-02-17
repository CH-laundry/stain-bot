const express = require('express');
const line = require('@line/bot-sdk');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// 安全验证环境变量
const validateConfig = () => {
  const missing = [];
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!process.env.LINE_CHANNEL_SECRET) missing.push('LINE_CHANNEL_SECRET');
  if (missing.length > 0) {
    console.error(`致命错误：缺少环境变量 ${missing.join(', ')}`);
    process.exit(1);
  }
};
validateConfig();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();
const upload = multer({ dest: 'uploads/' });

// 强化 JSON 解析中间件
app.use(express.json({
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString()); // 预验证 JSON 格式
    } catch (e) {
      console.error('无效的 JSON 格式:', buf.toString());
      throw new Error('Invalid JSON');
    }
  }
}));

// LINE 中间件错误处理
const lineMiddleware = line.middleware(config);
app.post('/webhook', (req, res, next) => {
  lineMiddleware(req, res, (err) => {
    if (err) {
      console.error('LINE 签名验证失败:', err.message);
      return res.status(401).send('Unauthorized');
    }
    next();
  });
});

// 核心逻辑处理
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];
    
    // 并行处理所有事件
    const promises = events.map(async (event) => {
      if (event.type !== 'message' || event.message.type !== 'text') {
        console.log('忽略非文本消息:', event.type);
        return;
      }

      if (!event.replyToken) {
        console.warn('缺少 replyToken，事件 ID:', event.message.id);
        return;
      }

      // 构造响应消息
      const response = {
        type: 'text',
        text: `你发送了: ${event.message.text}`,
        emojis: [
          {
            index: 5, // 在「发送了:」后面添加表情
            productId: '5ac21a8c040ab15980c9b43f',
            emojiId: '001'
          }
        ]
      };

      // 发送回复
      await client.replyMessage(event.replyToken, response);
      console.log('消息已成功发送，事件 ID:', event.message.id);
    });

    await Promise.all(promises);
    res.status(200).end();

  } catch (err) {
    console.error('全局错误捕获:', err.originalError?.response?.data || err.message);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      details: err.message
    });
  }
});

// 污渍分析端点
app.post('/analyze-stain', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未上传图片' });
  }

  const imagePath = path.join(__dirname, req.file.path);
  console.log(`收到图片: ${imagePath}`);

  // 模拟污渍分析逻辑（可以集成 AI 模型）
  const analysisResult = {
    successRate: Math.floor(Math.random() * 100), // 模拟清洁成功率
    material: 'Cotton', // 假设的衣物材质
    recommendations: ['使用温水清洗', '避免使用漂白剂']
  };

  // 删除上传的图片（可选）
  fs.unlink(imagePath, (err) => {
    if (err) console.error('删除文件失败:', err);
  });

  res.json(analysisResult);
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务运行中，监听端口 ${PORT}`);
  console.log(`Webhook URL: https://stain-bot-production-33a5.up.railway.app/webhook`);
  console.log(`污渍分析端点: https://stain-bot-production-33a5.up.railway.app/analyze-stain`);
});