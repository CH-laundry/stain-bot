const express = require('express');
const { createHash } = require('crypto');
const { Client } = require('@line/bot-sdk');
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

const MAX_USES_PER_USER = parseInt(process.env.MAX_USES_PER_USER, 10) || 2;
const MAX_USES_TIME_PERIOD = parseInt(process.env.MAX_USES_TIME_PERIOD, 10) || 604800;

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
});

// ============== 使用次數檢查 ==============
const store = new Map();

/**
 * 檢查用戶是否可以繼續使用，並且計算是否達到每週的使用次數上限
 * @param {string} userId 用戶ID
 * @returns {Promise<boolean>} true: 可以使用, false: 達到限制
 */
async function checkUsage(userId) {
  if (process.env.ADMIN && process.env.ADMIN.includes(userId)) {
    return true; // ADMIN 用戶無限制
  }

  const key = `rate_limit:user:${userId}`;
  const now = Date.now();
  const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

  try {
    let userActions = store.get(key);
    if (!userActions) {
      userActions = [];
    }

    // 移除過期的 action 時間戳
    userActions = userActions.filter(timestamp => timestamp > now - timePeriodMs);

    if (userActions.length < MAX_USES_PER_USER) {
      userActions.push(now); // 添加新的 action 時間戳
      store.set(key, userActions); // 更新 store
      return true; // 允許使用
    } else {
      return false; // 達到限制，拒絕使用
    }
  } catch (error) {
    console.error("Map 存儲限流錯誤:", error);
    return true;
  }
}

const userState = {};

// ============== 動態表情符號 ==============
const dynamicEmojis = {
  "洗鞋": "👟",
  "窗簾": "🪟",
  "衣服": "👕",
  "包包": "👜",
  "沙發": "🛋️",
  "地毯": "🧹"
};

// ============== 關鍵字回應系統 ==============
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
  "醬油": "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶",
  "多少錢|費用|洗這個多少|怎麼收費|怎麼算": "可以參考我們的服務價目表，包包類或其他衣物可以跟我們說，另外跟您回覆，謝謝您！",
  "寶寶汽座|汽座|兒童座椅|兒童安全座椅|手推車|單人推車|單人手推車|雙人推車|寶寶手推車": "寶寶汽座&手推車"
};

// ============== 急件模糊關鍵字檢查 ==============
function isUrgentInquiry(text) {
  const urgentKeywords = ["急件", "加急", "趕時間", "快一點", "盡快", "緊急"];
  return urgentKeywords.some(keyword => text.includes(keyword));
}

// ============== 智能污漬分析 ==============
async function analyzeStain(userId, imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

    console.log('圖片已接收，hash值:', imageHash);

    // 調用 OpenAI API 進行圖片分析（使用 GPT-4o 模型）
    const openaiResponse = await openaiClient.chat.completions.create({
      model: 'gpt-4', // 使用 GPT-4o 模型
      messages: [{
        role: 'system',
        content: '你是專業的洗衣助手，你的任務是分析使用者提供的衣物污漬圖片，提供清洗成功的機率，同時機率輸出必須是百分比（例如50%），和具體的污漬類型信息，但是不要提供清洗建議，每句話結尾加上 “我們會以不傷害材質盡量做清潔處理。”。'
      }, {
        role: 'user',
        content: [
          { type: 'text', text: '請分析這張衣物污漬圖片，並給予清潔建議。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }]
    });

    // 回覆分析結果
    const analysisResult = openaiResponse.choices[0].message.content;
    await client.pushMessage(userId, {
      type: 'text',
      text: `${analysisResult}\n\n✨ 智能分析完成 👕`
    });
  } catch (err) {
    console.error("OpenAI 服務出現錯誤:", err);
    await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
  }
}

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // 確保 LINE 收到回調

  try {
    const events = req.body.events;
    console.log(JSON.stringify(events, null, 2));
    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toLowerCase();

      // 文字訊息處理
      if (event.message.type === 'text') {
        // 1. 急件模糊關鍵字檢查
        if (isUrgentInquiry(text)) {
          if (text.includes("3天") || text.includes("三天")) {
            await client.pushMessage(userId, {
              type: 'text',
              text: '不好意思，清潔需要一定的工作日，可能會來不及😢。'
            });
          } else {
            await client.pushMessage(userId, {
              type: 'text',
              text: '不好意思，清潔是需要一定的工作日，這邊客服會再跟您確認⏳。'
            });
          }
          continue;
        }

        // 2. 送洗進度特殊處理
        if (["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"].some(k => text.includes(k))) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍',
            quickReply: {
              items: [{
                type: "action",
                action: {
                  type: "uri",
                  label: "C.H精緻洗衣",
                  uri: "https://liff.line.me/2004612704-JnzA1qN6#/"
                }
              }]
            }
          });
          continue;
        }

        // 3. 按「1」啟動智能污漬分析
        if (text === '1') {
          if (userState[userId] && userState[userId].imageBuffer) {
            await analyzeStain(userId, userState[userId].imageBuffer);
            delete userState[userId]; // 清除用戶狀態
          } else {
            await client.pushMessage(userId, {
              type: 'text',
              text: '請先上傳圖片以進行智能污漬分析。'
            });
          }
          continue;
        }

        // 4. 關鍵字優先匹配
        let matched = false;
        for (const [keys, response] of Object.entries(keywordResponses)) {
          if (keys.split('|').some(k => text.includes(k))) {
            await client.pushMessage(userId, { type: 'text', text: response });
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // 5. 未觸發關鍵字的 AI 客服一律不回應
        continue;
      }

      // 圖片訊息（智能污漬分析）
      if (event.message.type === 'image') {
        try {
          console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`);

          // 從 LINE 獲取圖片內容
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];

          // 下載圖片並拼接為一個Buffer
          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const buffer = Buffer.concat(chunks);

          // 存儲圖片 Buffer 到用戶狀態
          userState[userId] = { imageBuffer: buffer };

          // 如果用戶已經回覆「1」，則直接進行分析
          if (userState[userId] && userState[userId].imageBuffer) {
            await analyzeStain(userId, userState[userId].imageBuffer);
            delete userState[userId]; // 清除用戶狀態
          } else {
            // 提示用戶按「1」啟動分析
            await client.pushMessage(userId, {
              type: 'text',
              text: '已收到您的圖片，請回覆「1」開始智能污漬分析。'
            });
          }
        } catch (err) {
          console.error("處理圖片時出錯:", err);
          await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
        }
      }
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// ============== 啟動伺服器 ==============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器正在運行，端口：${PORT}`);
});
