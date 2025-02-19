const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { createClient } = require('redis');
const sharp = require('sharp');
const cors = require('cors'); // 新增 CORS 模块
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
  limits: { fileSize: 10 * 1024 * 1024 } // 限制上传文件为10MB
});

// ============== Redis初始化 ==============
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 15000, // 延长超时时间
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
app.use(cors({ // 新增 CORS 配置
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' })); // 增加请求体限制

// 强制HTTPS（生产环境）
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    return next();
  });
}

// 请求日志中间件（新增）
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============== 路由处理 ==============
// Redis测试路由
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

// 文件上传测试路由（新增）
app.post('/upload-test', upload.single('test'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '需要上传文件' });
  res.json({
    originalname: req.file.originalname,
    size: `${req.file.size} bytes`,
    mimetype: req.file.mimetype
  });
});

// LINE Webhook处理
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body.events || [];
    
    for (const event of events) {
      if (event.type !== 'message' || !event.replyToken) continue;

      // 文本消息处理
      if (event.message.type === 'text') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '请发送污渍照片进行分析 📸'
        });
      }
      
      // 图片消息处理（优化版）
      if (event.message.type === 'image') {
        try {
          // 添加超时机制
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('图片下载超时')), 10000)
          );

          const stream = await Promise.race([
            client.getMessageContent(event.message.id),
            timeoutPromise
          ]);

          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          
          const buffer = Buffer.concat(chunks);
          
          // 图片压缩处理
          const processedBuffer = await sharp(buffer)
            .resize(800, 800, { fit: 'inside' })
            .jpeg({ 
              quality: 70,
              mozjpeg: true 
            })
            .toBuffer();

          // 缓存处理（优化键名生成）
          const cacheKey = `img:${createHash('sha256').update(processedBuffer).digest('hex')}`;
          
          // ...保持原有缓存逻辑...
          
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

// 图片分析接口（增强版）
app.post('/analyze-stain', 
  upload.single('image'), 
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: '需要上传图片' });
      }

      // 添加文件类型验证
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
        confidence: Math.floor(Math.random() * 100) + '%',
        fileInfo: {
          size: `${req.file.size} bytes`,
          type: req.file.mimetype
        }
      };

      fs.unlink(req.file.path, (err) => {
        if (err) console.error('删除临时文件失败:', err);
      });

      res.json(result);
    } catch (err) {
      console.error('分析接口错误:', err);
      res.status(500).json({ error: '服务器内部错误' });
    }
  }
);

// 健康检查（增强版）
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

// 404处理（新增）
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 错误处理中间件（新增）
app.use((err, req, res, next) => {
  console.error('全局错误:', err.stack);
  res.status(500).json({ 
    error: '服务器错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '请联系管理员'
  });
});

// 启动服务
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`服务运行中：http://localhost:${port}`);
  console.log(`线上端点：https://stain-bot-production-33a5.up.railway.app`);
  console.log('当前环境:', process.env.NODE_ENV || 'development');
});