const express = require('express');
const { Client } = require('@line/bot-sdk');
const { createHash } = require('crypto');
const { OpenAI } = require('openai');
require('dotenv').config();

// ============== 环境变量检查 ==============
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'OPENAI_API_KEY'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`错误：缺少环境变量 ${varName}`);
    process.exit(1);
  }
});

// ============== 每周使用限制 ==============
const MAX_WEEKLY_USES = 2;
const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
const usageStore = new Map(); // { userId: timestamp[] }

// ============== LINE 客户端配置 ==============
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(),
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
});

const app = express();
app.use(express.json());

// ============== OpenAI 初始化 ==============
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim()
});

// ============== 模糊关键词回应 ==============
const keywordResponses = {
  "營業": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  "開門": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  "休息": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  "開店": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  "有開": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  "收送": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  "到府": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  "上門": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  "收衣": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  "預約": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  "清洗": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "清潔": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "洗多久": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "多久": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "會好": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "送洗時間": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "洗好了嗎": "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍",
  "洗好": "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍",
  "送回": "清洗完成後會送回給您，送達時也會通知您喔！🚚",
  "拿回": "衣物清洗完成後會送回，請放心！😄",
  "洗的掉": "我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨",
  "洗掉": "我們會盡力處理污漬，但滲透到纖維或時間較久的污漬可能無法完全去除，請見諒！😊",
  "染色": "染色問題我們會盡量處理，但如果滲透到衣物纖維或面積較大，不能保證完全處理喔！🌈",
  "退色": "已經退色的衣物是無法恢復的，請見諒！🎨",
  "油漬": "油漬我們有專門的處理方式，大部分都可以變淡，請放心！🍳",
  "血漬": "血漬我們會盡力處理，但成功率視沾染時間和材質而定喔！💉",
  "醬油": "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶"
};

// ============== 使用次数检查 ==============
function checkWeeklyLimit(userId) {
  const now = Date.now();
  const userUsages = usageStore.get(userId) || [];
  const recentUsages = userUsages.filter(t => now - t < WEEK_IN_MS);
  
  if (recentUsages.length >= MAX_WEEKLY_USES) return false;
  usageStore.set(userId, [...recentUsages, now]);
  return true;
}

// ============== 图片分析处理 ==============
async function handleImage(userId, event) {
  try {
    // 检查使用次数
    if (!checkWeeklyLimit(userId)) {
      await client.pushMessage(userId, {
        type: 'text',
        text: '您已達本週使用上限，請稍後再試。⏳'
      });
      return;
    }

    // 下载图片
    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // 调用 OpenAI API
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4-vision-preview',
      messages: [{
        role: 'system',
        content: '严格按格式回应：\n1. 污渍类型\n2. 清洁成功率 (百分比)\n3. "我们会以不伤害材质的方式处理"'
      }, {
        role: 'user',
        content: [{
          type: 'text',
          text: '分析此污渍'
        }, {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` }
        }]
      }]
    });

    // 发送分析结果
    await client.pushMessage(userId, {
      type: 'text',
      text: `${response.choices[0].message.content}\n\n✨ 智能分析完成 👕`
    });

  } catch (error) {
    console.error('分析失败:', error);
    await client.pushMessage(userId, {
      type: 'text',
      text: '分析服务暂时不可用，请稍后再试！🛠️'
    });
  }
}

// ============== Webhook 主逻辑 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || !event.source?.userId) continue;
      
      const userId = event.source.userId;
      const message = event.message;

      // 文字消息处理
      if (message.type === 'text') {
        const text = message.text.trim().toLowerCase();

        // 启动指令
        if (text === '1') {
          await client.pushMessage(userId, {
            type: 'text',
            text: '请上传污渍照片进行智能分析 📸'
          });
          continue;
        }

        // 关键词匹配
        const matchedKey = Object.keys(keywordResponses).find(k => text.includes(k));
        if (matchedKey) {
          await client.pushMessage(userId, {
            type: 'text',
            text: keywordResponses[matchedKey]
          });
          continue;
        }

        // 默认回应
        await client.pushMessage(userId, {
          type: 'text',
          text: '您好！请问有什么可以帮您？😊'
        });
      }

      // 图片消息处理
      if (message.type === 'image') {
        await handleImage(userId, event);
      }
    }
  } catch (err) {
    console.error('全局错误:', err);
  }
});

// ============== 启动服务器 ==============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务运行中，端口：${PORT}`);
});