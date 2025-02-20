const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { createClient } = require('redis');
const sharp = require('sharp');
const cors = require('cors');
const { createHash } = require('crypto'); // 新增哈希模块
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

const client = new Client(config);
const app = express();
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ============== Redis初始化 ==============
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 15000,
    tls: false,
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000)
  }
});
redisClient.on('error', err => console.error('Redis错误:', err));
(async () => {
  try {
    await redisClient.connect();
    console.log('Redis已连接');
  } catch (err) {
    console.error('Redis连接失败:', err);
  }
})();

// ============== 中间件配置 ==============
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============== 路由注册 ==============
// 健康检查
app.get('/health', (req, res) => {
  const healthData = {
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    redis: redisClient.isOpen ? 'connected' : 'disconnected',
    memoryUsage: process.memoryUsage()
  };
  res.json(healthData);
});

// Redis测试
app.get('/redis-test', async (req, res) => {
  try {    
    await redisClient.set('stain-bot-test', 'OK', { EX: 60 });
    const value = await redisClient.get('stain-bot-test');
    res.json({ 
      status: value ? 'success' : 'fail',
      redisValue: value 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 图片分析接口
app.post('/analyze-stain', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '需要上传图片' });

    // 文件类型验证
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '仅支持JPEG/PNG/WEBP格式' });
    }

    // 模拟处理延迟
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = {
      stainType: ['咖啡渍', '油渍', '血渍'][Math.floor(Math.random() * 3)],
      cleanMethod: '使用温水加中性清洁剂',
      confidence: Math.floor(Math.random() * 100) + '%'
    };

    fs.unlink(req.file.path, (err) => {
      if (err) console.error('删除临时文件失败:', err);
    });

    res.json(result);
  } catch (err) {
    console.error('分析接口错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// LINE Webhook处理
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body.events || [];
    
    for (const event of events) {
      if (event.type !== 'message' || !event.replyToken) continue;

      if (event.message.type === 'text') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '请发送污渍照片进行分析 📸'
        });
      }
      
      if (event.message.type === 'image') {
        try {
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];
          
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          
          const buffer = Buffer.concat(chunks);
          const cacheKey = `img:${createHash('sha256').update(buffer).digest('hex')}`;
          
          // ...缓存逻辑保持不变...

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

// ============== 生产环境HTTPS重定向 ==============
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ============== 错误处理 ==============
app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, next) => {
  console.error('全局错误:', err.stack);
  res.status(500).json({ 
    error: '服务器错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '请联系管理员'
  });
});

// ============== 服务启动 ==============
const port = Number(process.env.PORT) || 3000; // 强制转换为数字
app.listen(port, () => {
  console.log(`服务运行中，端口：${port}`);
  console.log('当前环境:', process.env.NODE_ENV || 'development');
});