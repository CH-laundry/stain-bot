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
  apiKey: process.env.OPENAI_API_KEY.trim()
});

// ============== 限制機制（保留原程式碼）=============
const store = new Map();
const startup_store = new Map();

async function isUserAllowed(userId) {
  const key = `rate_limit:user:${userId}`;
  const now = Date.now();
  const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

  let userActions = store.get(key) || [];
  userActions = userActions.filter(timestamp => timestamp > now - timePeriodMs);

  if (userActions.length < MAX_USES_PER_USER) {
    userActions.push(now);
    store.set(key, userActions);
    return true;
  }
  return false;
}

// ============== FAQ 及 AI 客服邏輯 ==============
const FAQ_KEYWORDS = [
  { keywords: ["營業", "開門", "休息", "開店", "有開"], reply: "您好 😊 我們的營業時間是 **10:30 - 20:00**，週六固定公休哦！" },
  { keywords: ["收送", "到府", "上門", "收衣", "預約"], reply: "我們提供 **免費到府收送** 服務！📍 江翠北芳鄰 1 件即收送 📍 板橋、新莊、三重、中和、永和滿 3 件或 500 元。\n💡 **可放置管理室，通知我們即可！**" },
  { keywords: ["清洗", "清潔", "洗多久", "多久", "會好", "送洗時間"], reply: "放心交給我們！🧼 **清洗時間約 7-10 個工作天**，完成後會自動通知您！" },
  { keywords: ["付費", "付款"], reply: "💰 **付款方式：現金、信用卡、LINE Pay、轉帳**，怎麼方便怎麼來 😊" },
  { keywords: ["洗好了嗎", "洗好"], reply: "🧐 幫您確認中... 營業時間內會通知您！💡 **您也可透過網頁查詢清洗進度哦！**" },
  { keywords: ["送回", "拿回"], reply: "🚚 **送回後會通知您，請放心！**" },
  { keywords: ["洗的掉", "洗掉", "染色", "退色", "油漬", "血漬", "醬油"], reply: "我們提供 **專業污漬處理**，但成功率依 **污漬種類 & 衣物材質** 而定。\n💡 **建議越快送洗效果越好哦！**" }
];

function getFAQResponse(userMessage) {
  userMessage = userMessage.toLowerCase();

  if (userMessage.includes("多少錢") || userMessage.includes("價格") || userMessage.includes("費用")) {
    if (userMessage.includes("付款") || userMessage.includes("付錢") || userMessage.includes("送回")) {
      return "稍後跟您說，謝謝您！💖";
    } else {
      return "📌 **您可以參考我們的服務價目**\n💡 **如是其他衣物，這邊再跟您回覆喔，謝謝您！** 😊";
    }
  }

  for (const item of FAQ_KEYWORDS) {
    if (item.keywords.some(keyword => userMessage.includes(keyword))) {
      return item.reply;
    }
  }
  return null;
}

async function getAIResponse(userMessage) {
  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "你是一個溫暖、親切的洗衣店客服機器人，只回答洗衣相關問題。" },
      { role: "user", content: userMessage }
    ]
  });
  return response.choices[0].message.content;
}

// ============== LINE Webhook（**原始程式碼 + AI 客服**）=============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/webhook', async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;

      if (event.message.type === 'text') {
        const text = event.message.text.trim().toLowerCase();

        let responseMessage = getFAQResponse(text);
        if (!responseMessage) {
          responseMessage = await getAIResponse(text);
        }

        await client.pushMessage(userId, { type: 'text', text: responseMessage });
      }

      // **保留你的圖片分析功能**
      if (event.message.type === 'image') {
        if (!await isUserAllowed(userId)) {
          await client.pushMessage(userId, { type: 'text', text: '您已達到每週兩次使用上限，請稍後再試。' });
          continue;
        }

        const stream = await client.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        const base64Image = buffer.toString('base64');

        const openaiResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: '你是洗衣助手，分析衣物污漬，提供清洗機率（百分比），請不要提供建議。' },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }] }
          ]
        });

        await client.pushMessage(userId, { type: 'text', text: openaiResponse.choices[0].message.content });
      }
    }
  } catch (err) {
    console.error("❌ 錯誤:", err);
  }
});

// ============== 服務啟動 ==============
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ 服務運行中，端口：${port}`);
});
