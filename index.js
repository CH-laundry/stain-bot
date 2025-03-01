const express = require('express');
const { Client } = require('@line/bot-sdk');
const { createHash } = require('crypto');
const { OpenAI } = require('openai');
require('dotenv').config();

// ============== 環境變數檢查 ==============
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'OPENAI_API_KEY'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`錯誤：缺少環境變數 ${varName}`);
    process.exit(1);
  }
});

// ============== 每週使用限制 ==============
const MAX_WEEKLY_USES = 2;
const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
const usageStore = new Map(); // { userId: timestamp[] }

// ============== LINE 客戶端配置 ==============
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

// ============== 模糊關鍵字回應 ==============
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

// ============== 使用次數檢查 ==============
function checkWeeklyLimit(userId) {
  const now = Date.now();
  const userUsages = usageStore.get(userId) || [];
  const recentUsages = userUsages.filter(t => now - t < WEEK_IN_MS);
  
  if (recentUsages.length >= MAX_WEEKLY_USES) return false;
  usageStore.set(userId, [...recentUsages, now]);
  return true;
}

// ============== 圖片分析處理 ==============
async function handleImage(userId, event) {
  try {
    // 檢查使用次數
    if (!checkWeeklyLimit(userId)) {
      await client.pushMessage(userId, {
        type: 'text',
        text: '您已達本週2次使用上限，請稍後再試。⏳'
      });
      return;
    }

    // 下載圖片
    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // 調用 OpenAI API
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4-vision-preview',
      messages: [{
        role: 'system',
        content: '嚴格按格式回應：\n1. 污漬類型\n2. 清潔成功率 (百分比)\n3. "我們會以不傷害材質的方式處理"'
      }, {
        role: 'user',
        content: [{
          type: 'text',
          text: '分析此污漬'
        }, {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` }
        }]
      }]
    });

    // 發送分析結果
    await client.pushMessage(userId, {
      type: 'text',
      text: `${response.choices[0].message.content}\n\n✨ 智能分析完成 👕`
    });

  } catch (error) {
    console.error('分析失敗:', error);
    await client.pushMessage(userId, {
      type: 'text',
      text: '分析服務暫時不可用，請稍後再試！🛠️'
    });
  }
}

// ============== 動態表情符號 ==============
function getEmojiForKeyword(text) {
  if (text.includes('鞋')) return '👟';
  if (text.includes('窗簾')) return '🪟';
  if (text.includes('衣服')) return '👕';
  if (text.includes('包包')) return '👜';
  return '✨'; // 預設表情
}

// ============== Webhook 主邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end();
  
  try {
    for (const event of req.body.events) {
      if (event.type !== 'message' || !event.source?.userId) continue;
      
      const userId = event.source.userId;
      const message = event.message;

      // 文字消息處理
      if (message.type === 'text') {
        const text = message.text.trim();

        // 強制不回應「智能污漬分析」
        if (text === '智能污漬分析') {
          continue; // 不回應
        }

        // 啟動指令
        if (text === '1') {
          await client.pushMessage(userId, {
            type: 'text',
            text: '請上傳污漬照片進行智能分析 📸'
          });
          continue;
        }

        // 關鍵字匹配
        const matchedKey = Object.keys(keywordResponses).find(k => text.includes(k));
        if (matchedKey) {
          await client.pushMessage(userId, {
            type: 'text',
            text: keywordResponses[matchedKey]
          });
          continue;
        }

        // 其他問題由 AI 回應
        const emoji = getEmojiForKeyword(text);
        const aiResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4',
          messages: [{
            role: 'system',
            content: '你是一個洗衣店客服機器人，請用簡潔明確的方式回答客戶的問題，並在結尾加上對應的表情符號。'
          }, {
            role: 'user',
            content: text
          }]
        });

        await client.pushMessage(userId, {
          type: 'text',
          text: `${aiResponse.choices[0].message.content} ${emoji}`
        });
      }

      // 圖片消息處理
      if (message.type === 'image') {
        await handleImage(userId, event);
      }
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// ============== 啟動伺服器 ==============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服務運行中，端口：${PORT}`);
});