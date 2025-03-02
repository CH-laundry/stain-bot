const express = require('express');
const { Client } = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const { createHash } = require('crypto');
require('dotenv').config();

// ============== LINE 配置 ==============
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(),
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
});

const app = express();
app.use(express.json()); // 解析 JSON 請求體

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim()
});

// ============== 關鍵字回應系統 ==============
const keywordResponses = {
  // 營業時間相關
  "營業|開門|休息|開店|有開": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
  
  // 收送服務相關（強化模糊匹配）
  "收送|免費收送|到府收送|有收送嗎|有到府收送嗎|送回|送回來|來收|來拿|收衣|收件|送衣": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
  
  // 清洗時間相關（嚴格匹配7-10天）
  "清洗|清潔|洗多久|多久|會好|送洗時間|可以拿|可以領|清洗時間": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
  
  // 特殊物品清洗費用
  "書包|書包清洗|書包費用": "我們書包清洗的費用是550元💼。",
  "汽座|寶寶汽座|嬰兒汽座|兒童安全座椅": "我們有清洗寶寶汽座（兒童安全座椅），費用是900元🚼。",
  "手推車|寶寶手推車|單人手推車": "我們有清洗寶寶手推車，費用是1200元👶。",
  "寶寶汽座&手推車": "寶寶汽座清洗900元🚼 / 手推車清洗1200元👶",

  // 新增模糊關鍵字：收回相關
  "收回了嗎|來收了嗎|收走了嗎|收走|拿了嗎|收了嗎|收件了嗎|拿走": "今日會收回，收回也會跟您通知的🚚。",

  // 新增模糊關鍵字：付款相關
  "如何付款|儲值|付費|付款|支付|給錢|收款|收錢": "我們可以現金💵、轉帳🏦、線上Line Pay📱、信用卡💳。"
};

// ============== 強制不回應列表 ==============
const ignoredKeywords = ["常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析"];

// ============== 智能污漬分析啟動狀態 ==============
const startup_store = new Map();

// ============== 使用次數檢查（改用內存存儲） ==============
const usageStore = new Map(); // 用於存儲用戶使用次數

async function checkUsage(userId) {
  // 如果是 ADMIN 用戶，直接返回 true（無限制）
  if (process.env.ADMIN && process.env.ADMIN.includes(userId)) {
    return true;
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const userUsage = usageStore.get(userId) || [];

  // 過濾出在時間週期內的記錄
  const validRecords = userUsage.filter(record => {
    return currentTime - record <= process.env.MAX_USES_TIME_PERIOD;
  });

  // 如果超過限制，返回 false
  if (validRecords.length >= process.env.MAX_USES_PER_USER) {
    return false;
  }

  // 添加新的使用記錄
  userUsage.push(currentTime);
  usageStore.set(userId, userUsage);

  return true;
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

      // 文字訊息
      if (event.message.type === 'text') {
        const text = event.message.text.trim().toLowerCase();

        // 1. 啟動智能污漬分析
        if (text === '1') {
          startup_store.set(userId, Date.now() + 180e3); // 設置 3 分鐘的有效期
          console.log(`用戶 ${userId} 開始使用`);
          await client.pushMessage(userId, { type: 'text', text: '請上傳圖片以進行智能污漬分析📸' });
          continue;
        }

        // 2. 關鍵字優先匹配
        let matched = false;
        for (const [keys, response] of Object.entries(keywordResponses)) {
          if (keys.split('|').some(k => text.includes(k))) {
            await client.pushMessage(userId, { type: 'text', text: response });
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // 3. 送洗進度特殊處理
        if (["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"].some(k => text.includes(k))) {
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

        // 4. 其他問題交由AI（嚴格限制回答格式）
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

        // 5. 嚴格過濾AI回答
        const aiText = aiResponse.choices[0].message.content;
        if (!aiText || aiText.includes('無法回答')) continue;

        await client.pushMessage(userId, { type: 'text', text: aiText });
      }

      // 圖片訊息（智能污漬分析）
      if (event.message.type === 'image') {
        try {
          if (!startup_store.get(userId) || startup_store.get(userId) < Date.now()) {
            console.log(`用戶 ${userId} 上傳了圖片，但是未開始使用`);
            startup_store.delete(userId);
            continue;
          }

          console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`);

          startup_store.delete(userId);

          // 檢查使用次數
          if (!(await checkUsage(userId))) {
            console.log(`用戶 ${userId} 使用次數到達上限`);
            await client.pushMessage(userId, { type: 'text', text: '您已經達到每週兩次使用次數上限，請稍後再試。' });
            continue;
          }

          console.log(`正在下載來自 ${userId} 的圖片...`);
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

          // 調用 OpenAI API 進行圖片分析（使用 GPT-4o 模型）
          const openaiResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o', // 使用 GPT-4o 模型
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
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// ============== 啟動服務 ==============
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`服務運行中，端口：${port}`));