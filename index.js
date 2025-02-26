const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { createHash } = require('crypto');
const { OpenAI } = require('openai');

require('dotenv').config();

// ============== 環境變數強制檢查 ==============
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'OPENAI_API_KEY',
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
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(),
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
};

const client = new Client(config);
const app = express();

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim(),
  organization: process.env.OPENAI_ORG_ID.trim(),
  project: process.env.OPENAI_PROJECT_ID.trim()
})

// ============== Redis 限流 ==============
const store = new Map();

/**
 * 检查用户是否可以继续使用，如果可以则增加使用次数 (使用 Map 存储)
 * @param {string} userId 用户ID
 * @returns {Promise<boolean>} true: 可以使用, false: 达到限制
 */
async function isUserAllowed(userId) {
  const key = `rate_limit:user:${userId}`;
  const now = Date.now();
  const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

  try {
    let userActions = store.get(key);
    if (!userActions) {
      userActions = [];
    }

    // 移除过期的 action 时间戳
    userActions = userActions.filter(timestamp => timestamp > now - timePeriodMs);

    if (userActions.length < MAX_USES_PER_USER) {
      userActions.push(now); // 添加新的 action 时间戳
      store.set(key, userActions); // 更新 store
      return true; // 允许使用
    } else {
      return false; // 达到限制，拒绝使用
    }
  } catch (error) {
    console.error("Map 存储限流错误:", error);
    return true;
  }
}

// ============== 中間件 ==============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // 確保 LINE 收到回調

  try {
    const events = req.body.events;
    console.log(JSON.stringify(events, null, 2));
    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;

      if (event.message.type === 'image') {
        try {
          console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`)

          if (!(await isUserAllowed(userId))) {
            console.log(`用戶 ${userId} 使用次數到達上限`);  
            await client.pushMessage(userId, { type: 'text', text: '您已經達到使用次數上限，請稍後再試。' });
            continue;
          }

          console.log(`正在下載來自 ${userId} 的圖片...`)
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

          console.log('圖片已接收，hash值:', imageHash, `消息ID: ${event.message.id}`);

          // 調用 OpenAI API 進行圖片分析 (這裡假設圖片已經轉為適當的格式)
          const openaiResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o', // 可選擇適當的模型
            messages: [
              {
                role: 'system',
                content: '你是專業的洗衣助手，你的任務是分析使用者提供的衣物污漬圖片，提供清洗成功的機率，同時機率輸出必須是百分比，例如50%。不要輸出具體的清潔步驟'
              },
              {
                role: 'user',
                content: '請分析這張衣物污漬圖片，並給予清潔建議。'
              },
              {
                role: "assistant",
                content: '中等（約50-70%），具體結果取決於污漬的種類與深度。'
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
                      url: `data:image/png;base64,${base64Image}`
                    }
                  }
                ]
              }
            ]
          })

          console.log('OpenAI 回應:', openaiResponse.data.choices[0].message.content);
          // 回覆用戶
          await client.pushMessage(userId, [
            { type: 'text', text: openaiResponse.data.choices[0].message.content }
          ]);
        } catch (err) {
          console.log("OpenAI 服務出現錯誤: ")
          console.error(err);
          console.log(`用戶ID: ${userId}`);

          await client.pushMessage(userId, [
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
const port = process.env.PORT || 3000; // 設置運行端口，默認為3000
app.listen(port, () => {
  console.log(`服務運行中，端口：${port}`);
});
