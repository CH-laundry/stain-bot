// ============== 強制不回應列表 ==============
const ignoredKeywords = ["常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析"];

// ============== 引入依賴 ==============
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
  "寶寶汽座": "我們有清洗寶寶汽座，費用是 $900 👶",
  "汽座": "我們有清洗寶寶汽座，費用是 $900 👶（註：汽座指的是寶寶汽座，不是汽車座椅喔！）",
  "兒童座椅": "我們有清洗寶寶汽座，費用是 $900 👶",
  "安全兒童座椅": "我們有清洗寶寶汽座，費用是 $900 👶",
  "手推車": "我們有清洗手推車，寶寶單人手推車費用是 $1200 🛒，雙人手推車費用是 $1800 🛒",
  "單人手推車": "我們有清洗寶寶單人手推車，費用是 $1200 🛒",
  "寶寶手推車": "我們有清洗寶寶手推車，費用是 $1200 🛒",
  "書包": "我們有清洗書包，費用是 $550 🎒",
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

// ============== 判斷是否為付款方式詢問 ==============
function isPaymentInquiry(text) {
  const paymentKeywords = [
    "付款", "付費", "支付", "怎麼付", "如何付", "付錢"
  ];
  return paymentKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為清洗方式詢問 ==============
function isWashMethodInquiry(text) {
  const washMethodKeywords = [
    "水洗", "乾洗", "如何清洗", "怎麼洗", "清潔方式"
  ];
  return washMethodKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為清洗進度詢問 ==============
function isProgressInquiry(text) {
  const progressKeywords = [
    "洗好", "洗好了嗎", "進度", "好了嗎", "完成了嗎"
  ];
  return progressKeywords.some(keyword => text.includes(keyword));
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

// ============== 判斷是否為清洗時間詢問 ==============
function isCleaningTimeInquiry(text) {
  const cleaningTimeKeywords = [
    "清潔時間", "拿到", "洗要多久", "多久", "會好", "送洗時間"
  ];
  return cleaningTimeKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否與洗衣店相關 ==============
function isLaundryRelated(text) {
  const laundryKeywords = [
    "洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾",
    "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", "書包",
    "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約", "洗多久", "洗好", "洗好了嗎", "送回", "拿回"
  ];
  return laundryKeywords.some(keyword => text.includes(keyword));
}

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;

      // 文字訊息
      if (event.message.type === 'text') {
        const text = event.message.text.trim().toLowerCase();

        // 檢查是否包含強制不回應的關鍵字
        const shouldIgnore = ignoredKeywords.some(keyword => text.includes(keyword.toLowerCase()));
        if (shouldIgnore) {
          console.log(`用戶 ${userId} 的訊息包含強制不回應關鍵字，已忽略。`);
          continue; // 跳過回應
        }

        // 檢查是否與洗衣店相關
        const isRelated = isLaundryRelated(text);
        if (!isRelated) {
          console.log(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。`);
          continue; // 跳過回應
        }

        // 1. 按「1」啟動智能污漬分析
        if (text === '1') {
          await client.pushMessage(userId, {
            type: 'text',
            text: '請上傳照片，以進行智能污漬分析✨📷'
          });
          userState[userId] = { waitingForImage: true }; // 標記用戶正在等待圖片
          continue;
        }

        // 2. 判斷付款方式詢問
        if (isPaymentInquiry(text)) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '我們可以現金💵、線上Line Pay📱、信用卡💳、轉帳🏦。'
          });
          continue;
        }

        // 3. 判斷清洗方式詢問
        if (isWashMethodInquiry(text)) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '我們會依照衣物上的洗標來做清潔，也會判斷如何清潔，會以不傷害材質來清潔的✨👕。'
          });
          continue;
        }

        // 4. 判斷清洗進度詢問
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

        // 5. 判斷“能洗掉”的問題
        if (["洗的掉", "洗掉", "會洗壞"].some(k => text.includes(k))) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨'
          });
          continue;
        }

        // 6. 判斷價格詢問
        if (isPriceInquiry(text)) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '可以參考我們的服務價目表或由客服跟您回覆📋。'
          });
          continue;
        }

        // 7. 判斷是否為急件詢問
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

        // 8. 判斷是否為清洗時間詢問
        if (isCleaningTimeInquiry(text)) {
          await client.pushMessage(userId, {
            type: 'text',
            text: '我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳'
          });
          continue;
        }

        // 9. 關鍵字匹配回應
        let matched = false;
        for (const [key, response] of Object.entries(keywordResponses)) {
          if (text.includes(key)) {
            await client.pushMessage(userId, { type: 'text', text: response });
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // 10. AI 客服回應洗衣店相關問題
        const aiResponse = await openaiClient.chat.completions.create({
          model: 'gpt-4',
          messages: [{
            role: 'system',
            content: '你是一個洗衣店客服，回答需滿足：1.用口語化中文 2.結尾加1個表情 3.禁用專業術語 4.不提及時間長短 5.無法回答時不回應'
          }, {
            role: 'user',
            content: text
          }]
        });

        const aiText = aiResponse.choices[0].message.content;
        if (!aiText || aiText.includes('無法回答')) continue;

        await client.pushMessage(userId, { type: 'text', text: aiText });
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

          // 如果用戶正在等待圖片，則直接進行分析
          if (userState[userId] && userState[userId].waitingForImage) {
            await analyzeStain(userId, buffer);
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

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器正在運行，端口：${PORT}`);
});