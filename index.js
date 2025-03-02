const express = require('express');
const { createHash } = require('crypto');
const { Client } = require('@line/bot-sdk');
const { OpenAI } = require('openai');
require('dotenv').config();

// 初始化 Express 應用程式
const app = express();
app.use(express.json()); // 解析 JSON 請求體

// 初始化 LINE 客戶端
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 初始化 OpenAI 客戶端
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 用戶狀態存儲
const userState = {};
const store = new Map();

// 設置最大使用次數和時間週期
const MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
const MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800; // 604800秒為一周

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
  "洗多久": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  "洗好": "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍",
  "洗好了嗎": "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍",
  "送回": "清洗完成後會送回給您，送達時也會通知您喔！🚚",
  "拿回": "衣物清洗完成後會送回，請放心！😄",
  "油漬": "油漬我們有專門的處理方式，大部分都可以變淡，請放心！🍳",
  "血漬": "血漬我們會盡力處理，但成功率視沾染時間和材質而定喔！💉",
  "醬油": "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶",
  "寶寶汽座": "寶寶汽座 $900 👶",
  "單人手推車": "寶寶單人手推車 $1200 🛒",
  "雙人手推車": "雙人手推車 $1800 🛒",
  "書包": "書包 $550 🎒",
  "洗的掉": "我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨",
  "洗掉": "我們會盡力處理污漬，但滲透到纖維或時間較久的污漬可能無法完全去除，請見諒！😊",
  "染色": "染色問題我們會盡量處理，但如果滲透到衣物纖維或面積較大，不能保證完全處理喔！🌈",
  "退色": "已經退色的衣物是無法恢復的，請見諒！🎨",
  "清洗地毯": "我們提供地毯清洗服務，請告知我們您需要清洗的地毯狀況，我們會根據情況安排清洗。🧹",
  "清洗窗簾": "我們提供窗簾清洗服務，請提供您的窗簾尺寸和材質，以便我們安排清洗。🪟",
  "是否能清洗衣物": "我們提供各式衣物清洗服務，無論是衣服、外套、襯衫等都可以清洗。👕"
};

// ============== 使用次數檢查 ==============
async function checkUsage(userId) {
  const key = `rate_limit:user:${userId}`;
  const now = Date.now();
  const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

  try {
    let userActions = store.get(key);
    if (!userActions) {
      userActions = [];
    }

    // 移除過期的 action 时间戳
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

// ============== 智能污漬分析 ==============
async function analyzeStain(userId, imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

    console.log('圖片已接收，hash值:', imageHash);

    // 調用 OpenAI API 進行圖片分析（使用 GPT-4o 模型）
    const openaiResponse = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
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

// ============== 判斷是否為急件詢問 ==============
function isUrgentInquiry(text) {
  const urgentKeywords = [
    "急件", "趕件", "快一點", "加急", "趕時間"
  ];
  return urgentKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷價格詢問 ==============
function isPriceInquiry(text) {
  const priceKeywords = [
    "價格", "价錢", "收費", "費用", "多少錢", "價位", "算錢", "清洗費", "價目表",
    "這件多少", "這個價格", "鞋子費用", "洗鞋錢", "要多少", "怎麼算", "窗簾費用"
  ];
  return priceKeywords.some(keyword => text.includes(keyword));
}

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;
      const text = event.message.text.trim().toLowerCase();

      // 1. 判斷付款方式詢問
      if (isPaymentInquiry(text)) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '我們可以現金💵、線上Line Pay📱、信用卡💳、轉帳🏦。'
        });
        continue;
      }

      // 2. 判斷清洗方式詢問
      if (isWashMethodInquiry(text)) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '我們會依照衣物上的洗標來做清潔，也會判斷如何清潔，會以不傷害材質來清潔的✨👕。'
        });
        continue;
      }

      // 3. 判斷清洗進度詢問
      if (isProgressInquiry(text)) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '營業時間會馬上查詢您的清洗進度😊，並回覆您！或是您可以這邊線上查詢 C.H精緻洗衣 謝謝您🔍',
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

      // 4. 判斷“能洗掉”的問題
      if (["洗的掉", "洗掉", "會洗壞"].some(k => text.includes(k))) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨'
        });
        continue;
      }

      // 5. 關鍵字匹配回應
      let matched = false;
      for (const [key, response] of Object.entries(keywordResponses)) {
        if (text.includes(key)) {
          await client.pushMessage(userId, { type: 'text', text: response });
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // 6. AI 客服不回應無關問題
      continue; // 無回應
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器正在運行，端口：${PORT}`);
});
