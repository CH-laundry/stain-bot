const express = require('express'); // 導入 Express 模組
const { Client } = require('@line/bot-sdk'); // 導入 LINE SDK 模組
const { createHash } = require('crypto'); // 導入 crypto 模組用於生成哈希值
const { OpenAI } = require('openai'); // 導入 OpenAI 模組
require('dotenv').config(); // 導入 dotenv 用於讀取環境變數

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
const app = express(); // 初始化 Express 應用程式

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim(),
  organization: process.env.OPENAI_ORG_ID?.trim(), // 可選
  project: process.env.OPENAI_PROJECT_ID?.trim() // 可選
});

// ============== Redis 限流 ==============
const store = new Map();

/**
 * 檢查用戶是否可以繼續使用，如果可以則增加使用次數 (使用 Map 存儲)
 * @param {string} userId 用戶ID
 * @returns {Promise<boolean>} true: 可以使用, false: 達到限制
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

// ============== 中間件 ==============
app.use(express.json()); // 啟用 JSON 解析
app.use(express.urlencoded({ extended: true })); // 啟用 URL 編碼解析

// ============== 新增 AI 客服功能 ==============
async function getCustomerServiceResponse(userMessage) {
  const keywords = {
    "營業": "我們的營業時間為 10:30 - 20:00，週六固定公休喔！😊",
    "開門": "我們每天 10:30 開門，歡迎隨時來找我們！🌟",
    "休息": "週六是我們的公休日，其他時間都為您服務喔！💖",
    "開店": "我們每天 10:30 開店，期待您的光臨！🌸",
    "有開": "我們每天 10:30 - 20:00 都有開，週六休息喔！😄",
    "收送": "我們有免費到府收送服務，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！",
    "到府": "我們提供免費到府收送服務，歡迎預約！📦",
    "上門": "我們可以到府收送衣物，一件就免費喔！😊",
    "收衣": "我們有免費收衣服務，歡迎預約！👕",
    "預約": "可以透過 LINE 或官網預約我們的到府收送服務喔！📅",
    "清洗": "我們的清潔時間約 7-10 個工作天，完成後會自動通知您喔！⏳",
    "清潔": "清潔時間約 7-10 個工作天，請耐心等待！😊",
    "洗多久": "清洗時間約 7-10 個工作天，完成後會通知您！⏰",
    "多久": "清洗時間約 7-10 個工作天，請放心交給我們！💪",
    "會好": "清潔完成後會自動通知您，請稍等喔！😄",
    "送洗時間": "我們的送洗時間約 7-10 個工作天，完成後會通知您！📅",
    "價格": "可以參考我們的服務價目表，包包類麻煩您上傳照片，我們會回覆清洗價格喔！💰",
    "費用": "價格會根據衣物種類和清洗方式有所不同，包包類請上傳照片，我們會為您報價！💵",
    "多少錢": "您可以參考我們的服務價目表，如其它衣物這邊再跟您回覆的，謝謝您！💳", // 清洗前的詢問
    "付費": "我們接受現金、信用卡、LINE Pay 和轉帳付款喔！💳",
    "付款": "付款方式有現金、信用卡、LINE Pay 和轉帳，方便又安全！💵",
    "洗好了嗎": "正在查詢您的清洗進度，稍後回覆您！🔍",
    "洗好": "我們會盡快確認您的清洗進度，稍後通知您！😊",
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

  // 檢查是否有匹配的關鍵字
  for (const [keyword, response] of Object.entries(keywords)) {
    if (userMessage.includes(keyword)) {
      return response;
    }
  }

  // 如果沒有匹配的關鍵字，調用 OpenAI 生成回覆
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "你是一個洗衣店客服機器人，請用簡潔明確的方式回答客戶的問題，不要提供額外的清洗建議。例如：\n客戶：可以洗窗簾嗎？\n回應：可以的，我們有窗簾清潔服務喔！\n\n客戶：這件衣服洗得掉嗎？\n回應：我們會盡力處理，但成功率視污漬與材質而定。\n\n請以這種簡潔格式回答問題。"
        },
        { role: "user", content: userMessage }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("❌ OpenAI API 失敗: ", error);
    return "目前客服系統繁忙，請稍後再試 🙏";
  }
}

// ============== Webhook 路由 ==============
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

        // 如果用戶輸入「1」，啟動圖片分析功能
        if (text === '1') {
          startup_store.set(userId, Date.now() + 180e3); // 設置 3 分鐘的有效期
          console.log(`用戶 ${userId} 開始使用`);
          await client.pushMessage(userId, { type: 'text', text: '請上傳圖片' });
          continue;
        }

        // 處理「多少錢」的兩種情境
        if (text.includes("多少錢")) {
          // 情境 1：清洗前的詢問
          if (text.includes("清洗") || text.includes("送洗")) {
            await client.pushMessage(userId, { type: 'text', text: '您可以參考我們的服務價目表，如其它衣物這邊再跟您回覆的，謝謝您！💳' });
          }
          // 情境 2：送回衣物後的付款詢問
          else {
            await client.pushMessage(userId, { type: 'text', text: '稍後跟您說，謝謝您！😊' });
          }
          continue;
        }

        // 調用 AI 客服功能
        const responseMessage = await getCustomerServiceResponse(text);
        await client.pushMessage(userId, { type: 'text', text: responseMessage });
      }

      // 圖片訊息
      if (event.message.type === 'image') {
        try {
          // 檢查用戶是否已輸入「1」啟動圖片分析功能
          if (!startup_store.get(userId) || startup_store.get(userId) < Date.now()) {
            console.log(`用戶 ${userId} 上傳了圖片，但是未開始使用`);
            startup_store.delete(userId);
            continue;
          }

          console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`);

          startup_store.delete(userId);

          if (!(await isUserAllowed(userId)) && (process.env.ADMIN && !process.env.ADMIN.includes(userId))) {
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
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: [
                  '你是專業的洗衣助手，你的任務是分析使用者提供的衣物污漬圖片，提供清洗成功的機率，同時機率輸出必須是百分比（例如50%），和具体的污渍类型信息，但是不要提供清洗建议，每句话结尾加上 “我們會以不傷害材質盡量做清潔處理。”。',
                  '你的回复内容可以参考这段文本：“這張圖片顯示白色衣物上有大片咖啡色污漬。這類污漬通常是由於咖啡、茶或醬汁等液體造成的，清潔成功的機率大約在70-80%。由於顏色較深，實際清潔效果會依污漬的滲透程度、沾染時間與鞋材特性而定。某些污漬可能會變淡但無法完全去除，我們會以不傷害材質盡量做清潔處理。”'
                ].join("\n")
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
          });

          console.log('OpenAI 回應:', openaiResponse.choices[0].message.content);
          await client.pushMessage(userId, [
            { type: 'text', text: openaiResponse.choices[0].message.content }
          ]);
        } catch (err) {
          console.log("OpenAI 服務出現錯誤: ");
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