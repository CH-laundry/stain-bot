const express = require('express');
const line = require('@line/bot-sdk');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { createClient } = require('redis');
const sharp = require('sharp');
require('dotenv').config();

// ============== 环境变量检查 ==============
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error('错误：缺少LINE环境变量');
  process.exit(1);
}

// ============== 服务配置 ==============
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();
const upload = multer({ dest: 'uploads/' });

// ============== Redis初始化 ==============
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 5000 } // 增加超时设置
});
redisClient.on('error', err => console.error('Redis错误:', err));
(async () => {
  await redisClient.connect();
  console.log('Redis已连接');
})();

// ============== 中间件 ==============
app.use(express.json());

// ============== 路由处理 ==============
// Redis测试路由（新增）
app.get('/redis-test', async (req, res) => {
  try {
    await redisClient.set('stain-bot-test', 'OK');
    const value = await redisClient.get('stain-bot-test');
    res.json({ 
      status: value ? 'success' : 'fail',
      redisValue: value 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LINE Webhook处理（优化版）
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end(); // 立即响应
  
  try {
    const events = req.body.events || [];
    
    for (const event of events) {
      if (event.type !== 'message' || !event.replyToken) continue;

      // 文本消息
      if (event.message.type === 'text') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '请发送污渍照片进行分析 📸'
        });
      }
      
      // 图片消息（新增压缩+缓存逻辑）
      if (event.message.type === 'image') {
        try {
          const stream = await client.getMessageContent(event.message.id);
          let buffer = Buffer.concat(await stream.toArray());
          
          // 图片压缩
          buffer = await sharp(buffer)
            .resize(800, 800, { fit: 'inside' })
            .jpeg({ quality: 70 })
            .toBuffer();

          // 缓存检查
          const cacheKey = `img:${buffer.toString('hex').substring(0, 32)}`;
          let analysis = await redisClient.get(cacheKey);
          
          if (!analysis) {
            // 调用分析接口
            const formData = new FormData();
            formData.append('image', buffer, 'stain.jpg');
            const response = await fetch('http://localhost:3000/analyze-stain', {
              method: 'POST',
              body: formData
            });
            analysis = await response.json();
            
            // 缓存结果（1小时）
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(analysis));
          } else {
            analysis = JSON.parse(analysis);
          }

          // 发送结果
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `分析结果：\n🟢 类型：${analysis.stainType}\n🔧 方法：${analysis.cleanMethod}`
          });
        } catch (err) {
          console.error('图片处理失败:', err);
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '分析失败，请稍后重试'
          });
        }
      }
    }
  } catch (err) {
    console.error('全局错误:', err);
  }
});

// 图片分析接口
app.post('/analyze-stain', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).send('需要上传图片');
  
  // 模拟随机结果
  const result = {
    stainType: ['咖啡渍', '油渍', '血渍'][Math.floor(Math.random()*3)],
    cleanMethod: '使用温水加中性清洁剂',
    confidence: Math.floor(Math.random() * 100) + '%'
  };

  fs.unlink(req.file.path, () => {});
  res.json(result);
});

// 健康检查
app.get('/health', (req, res) => res.sendStatus(200));

// ============== 启动服务 ==============
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`服务运行中：http://localhost:${port}`);
  console.log(`线上端点：https://stain-bot-production-33a5.up.railway.app`);
});