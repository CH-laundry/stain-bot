const express = require('express');
const { Client } = require('@line/bot-sdk');
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

// ============== FAQ 及 AI 客服邏輯 ==============
const FAQ_KEYWORDS = [
  { keywords: ["營業", "開門", "休息", "開店", "有開"], reply: "您好 😊 我們的營業時間是 **10:30 - 20:00**，週六固定公休哦！" },
  { keywords: ["收送", "到府", "上門", "收衣", "預約"], reply: "我們有 **免費到府收送** 服務喔！\n📍 **江翠北芳鄰** 滿 1 件即可收送。\n📍 **板橋、新莊、三重、中和、永和** 滿 3 件或滿 **500 元** 也能免費收送！" },
  { keywords: ["清洗", "清潔", "洗多久", "多久", "會好", "送洗時間"], reply: "我們清潔時間約 **7-10 個工作天**，清潔完成後會 **自動通知您**，請放心哦！" },
  { keywords: ["付費", "付款"], reply: "我們接受 **現金、信用卡、LINE Pay、轉帳**，怎麼方便怎麼來 😊" },
  { keywords: ["洗好了嗎", "洗好"], reply: "幫您確認中...\n營業時間內查詢好會馬上通知您！\n💡 **您也可以透過網頁查詢目前的清洗進度哦～**" },
  { keywords: ["送回", "拿回"], reply: "我們會 **親自送回** 您的衣物 💁‍♀️\n🚚 **送達後會通知您，請放心**！" },
  { keywords: ["洗的掉", "洗掉", "染色", "退色", "油漬", "血漬", "醬油"], reply: "我們會 **盡量處理污漬**，但成功率視污漬種類與衣物材質而定。\n💡 **建議越快送洗效果會越好喔！**" }
];

function getFAQResponse(userMessage) {
  userMessage = userMessage.toLowerCase();
  
  // **處理價格詢問**
  if (userMessage.includes("多少錢") || userMessage.includes("價格") || userMessage.includes("費用")) {
    if (userMessage.includes("付款") || userMessage.includes("付錢") || userMessage.includes("送回")) {
      return "稍後跟您說，謝謝您！💖";
    } else {
      return "您可以參考我們的 **服務價目** 🏷️。\n📌 **如是其他衣物，這邊再跟您回覆喔，謝謝您！** 😊";
    }
  }

  // **模糊匹配 FAQ**
  for (const item of FAQ_KEYWORDS) {
    if (item.keywords.some(keyword => userMessage.includes(keyword))) {
      return item.reply;
    }
  }

  return null;
}

async function getAIResponse(userMessage) {
  const response = await openaiClient.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "你是一個溫暖、親切的洗衣店客服機器人，只回答洗衣相關問題。" },
      { role: "user", content: userMessage }
    ]
  });
  return response.choices[0].message.content;
}

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // 確保 LINE 收到回調

  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;

      if (event.message.type === 'text') {
        const text = event.message.text.trim().toLowerCase();

        // **先檢查 FAQ**
        let responseMessage = getFAQResponse(text);

        // **如果 FAQ 沒有匹配，就讓 OpenAI 處理**
        if (!responseMessage) {
          responseMessage = await getAIResponse(text);
        }

        await client.pushMessage(userId, { type: 'text', text: responseMessage });
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
