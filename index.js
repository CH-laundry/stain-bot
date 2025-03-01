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
  'MAX_USES_TIME_PERIOD',
  'ADMIN' // 無使用次數限制的用戶 ID
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
});

// ============== Redis 限流 ==============
const store = new Map();

/**
 * 檢查用戶是否可以繼續使用，如果可以則增加使用次數 (使用 Map 存儲)
 * @param {string} userId 用戶ID
 * @returns {Promise<boolean>} true: 可以使用, false: 達到限制
 */
async function isUserAllowed(userId) {
  // 如果是無使用次數限制的用戶，直接返回 true
  if (userId === process.env.ADMIN) {
    return true;
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

const startup_store = new Map();

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

      // 文字訊息
      if (event.message.type === 'text') {
        const text = event.message.text.trim();

        // 強制不回應「智能污漬分析」
        if (text === '智能污漬分析') {
          continue; // 不回應
        }

        // 啟動指令
        if (text === '1') {
          startup_store.set(userId, Date.now() + 180e3);
          console.log(`用戶 ${userId} 開始使用`);
          await client.pushMessage(userId, { type: 'text', text: '請上傳圖片' });
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
          text: `${aiResponse.choices[0].message.content} ✨`
        });
      }

      // 圖片訊息
      if (event.message.type === 'image') {
        try {
          if (!startup_store.get(userId) || startup_store.get(userId) < Date.now()) {
            console.log(`用戶 ${userId} 上傳了圖片，但是未開始使用`);
            startup_store.delete(userId);
            continue;
          }

          console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`);

          startup_store.delete(userId);

          if (!(await isUserAllowed(userId))) {
            console.log(`用戶 ${userId} 使用次數到達上限`);
            await client.pushMessage(userId, { type: 'text', text: '您已經達到每週兩次使用次數上限，請稍後再試。' });
            continue;
          }

          console.log(`正在下載來自 ${userId} 的圖片...`);
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];

          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const buffer = Buffer.concat(chunks);
          const base64Image = buffer.toString('base64');
          const imageHash = createHash('sha256').update(buffer).digest('hex');

          console.log('圖片已接收，hash值:', imageHash, `消息ID: ${event.message.id}`);

          // 調用 OpenAI API 進行圖片分析
          const openaiResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4-vision-preview',
            messages: [{
              role: 'system',
              content: '嚴格按格式回應：\n1. 污漬類型\n2. 清潔成功率 (百分比)\n3. "我們會以不傷害材質的方式處理"'
            }, {
              role: 'user',
              content: [{
                type: 'text',
                text: '請分析這張污漬圖片。'
              }, {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${base64Image}` }
              }]
            }]
          });

          console.log('OpenAI 回應:', openaiResponse.choices[0].message.content);
          await client.pushMessage(userId, {
            type: 'text',
            text: `${openaiResponse.choices[0].message.content}\n\n✨ 智能分析完成 👕`
          });
        } catch (err) {
          console.log("OpenAI 服務出現錯誤: ");
          console.error(err);
          console.log(`用戶ID: ${userId}`);

          await client.pushMessage(userId, {
            type: 'text',
            text: '服務暫時不可用，請稍後再試。'
          });
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