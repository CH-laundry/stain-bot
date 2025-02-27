const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { createHash } = require('crypto');
const { OpenAI } = require('openai');
const ioredis = require('ioredis');

require('dotenv').config();

// ============== 環境變數強制檢查 ==============
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'OPENAI_API_KEY',
  'REDIS_URL',
  'MAX_USES_PER_USER',
  'MAX_USES_TIME_PERIOD'
];

const MAX_USES_PER_USER = parseInt(process.env.MAX_USES_PER_USER, 10) || 10;
const MAX_USES_TIME_PERIOD = parseInt(process.env.MAX_USES_TIME_PERIOD, 10) || 3600;

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`錯誤：缺少環境變數 ${varName}`);
    process.exit(1);
  }
});

// ============== LINE 客戶端配置 ==============
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(), // 清除前後空格
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
};

const client = new Client(config);
const app = express();

const REDIS_URL = process.env.REDIS_URL.trim();
const redis = new ioredis(REDIS_URL);

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim(),
  organization: process.env.OPENAI_ORG_ID.trim(),
  project: process.env.OPENAI_PROJECT_ID.trim()
})

// ============== Redis 限流 ==============
async function isUserAllowed(userId) {
  const key = `rate_limit:user:${userId}`;
  const now = Date.now();
  const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

  try {
    const pipeline = redis.pipeline();
    pipeline.zcount(key, now - timePeriodMs, now);
    pipeline.zremrangebyscore(key, '-inf', now - timePeriodMs);

    const [countsResult] = await pipeline.exec();
    const currentUses = countsResult[1];

    if (currentUses < MAX_USES_PER_USER) {
      await redis.zadd(key, now, now);
      await redis.pexpire(key, timePeriodMs * 2);
      return true; // 允许使用
    } else {
      return false; // 达到限制，拒绝使用
    }
  } catch (error) {
    console.error("Redis 限流错误:", error);
    return false;
  }
}

// ============== 中間件 ==============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== 核心邏輯 ==============
app.post('/webhook', middleware(config), async (req, res) => {
  res.status(200).end(); // 確保 LINE 收到回調

  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || !event.replyToken) continue;

      const userId = event.source.userId;
      const replyToken = event.replyToken;

      if (event.message.type === 'image') {
        try {
          if (!(await isUserAllowed(userId))) {
            await client.replyMessage(replyToken, { type: 'text', text: '您已經達到使用次數上限，請稍後再試。' });
            continue;
          }

          // 從 LINE 獲取圖片內容
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];

          // 下載圖片並拼接為一個Buffer
          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const buffer = Buffer.concat(chunks);
          const base64Image = buffer.toString('base64');
          const imageHash = createHash('sha256').update(buffer).digest('hex');

          console.log('圖片已接收，hash值:', imageHash);

          // 調用 OpenAI API 進行圖片分析
          const openaiResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: '你是專業的洗衣助手，你的任務是分析使用者提供的衣物污漬圖片，提供清洗成功的機率，同時機率輸出必須是百分比，例如50%。不要輸出具體的清潔步驟。並分析衣物的材質。'
              },
              {
                role: 'user',
                content: '請分析這張衣物污漬圖片，並給予清潔建議，並分析衣物材質。'
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: '請分析這張衣物污漬圖片，並給予清潔建議。'
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`,
                      detail: "high"
                    }
                  }
                ]
              }
            ]
          })

          // 獲取回應內容
          let responseContent = openaiResponse.data.choices[0].message.content;

          // 降低清潔成功機率
          let successRateMatch = responseContent.match(/清潔成功機率: (\d+)%/);
          if (successRateMatch) {
            let successRate = parseInt(successRateMatch[1], 10);
            let adjustedRate = Math.max(0, successRate - 10); // 減少10%的成功機率
            responseContent = responseContent.replace(`清潔成功機率: ${successRate}%`, `清潔成功機率: ${adjustedRate}%`);
          }

          // 增加自定義回覆文字
          const replyMessage = `${responseContent}\n\n我們會以不傷材質來做清潔處理。`;

          // 如果回應中包含污漬分析結果，就回覆
          if (replyMessage.includes("清潔成功機率")) {
            await client.replyMessage(replyToken, [
              { type: 'text', text: replyMessage }
            ]);
          } else {
            // 如果沒有污漬，則不回應
            console.log("非污漬圖片，無回應");
          }
        } catch (err) {
          console.error('OpenAI 錯誤詳情:', {
            status: err.response?.status,
            data: err.response?.data,
            headers: err.config?.headers
          });

          await client.replyMessage(replyToken, [
            { type: 'text', text: '服務暫時不可用，請稍後再試。' }
          ]);
        }
      }
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// ============== 服務啟動 ==============
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`服務運行中，端口：${port}`);
});
