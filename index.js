const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { createHash } = require('crypto');
const { OpenAI } = require('openai');
require('dotenv').config();

// ============== 環境變數檢查 ==============
const requiredEnvVars = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'OPENAI_API_KEY', 'MAX_USES_PER_USER', 'MAX_USES_TIME_PERIOD', 'ADMIN'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`錯誤：缺少環境變數 ${varName}`);
    process.exit(1);
  }
});

// ============== LINE配置 ==============
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(),
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
});
const app = express();
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY.trim()
});

// ============== 使用 express.json() 來解析請求 ==============
app.use(express.json());  // 確保能正確處理 JSON 請求

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
  
  // 付款方式
  "如何付款|儲值|付費|付款|支付|給錢|收款|收錢": "我們可以現金、轉帳、線上Line Pay、信用卡的方式進行付款喔！💳"
};

// ============== 強制不回應列表 ==============
const ignoredKeywords = ["常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析"];

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
  // 確保請求中有 body 和 events
  if (!req.body || !req.body.events) {
    console.error('請求格式錯誤:', req.body);
    return res.status(400).send('Bad Request'); // 返回錯誤
  }

  res.status(200).end();

  try {
    for (const event of req.body.events.filter(e => e.type === 'message' && e.source.userId)) {
      const userId = event.source.userId;
      const text = event.message.text?.trim() || '';

      // 1. 強制不回應檢查
      if (ignoredKeywords.some(k => text.includes(k))) continue;

      // 2. 收回服務相關的回覆
      if (["收回了嗎", "來收了嗎", "收走了嗎", "收走", "拿了嗎", "收了嗎", "收件了嗎", "拿走"].some(k => text.includes(k))) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '今日會收回，收回後也會通知您。'
        });
        continue;
      }

      // 3. 付款相關問題回覆
      if (["如何付款", "儲值", "付費", "付款", "支付", "給錢", "收款", "收錢"].some(k => text.includes(k))) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '我們可以現金、轉帳、線上Line Pay、信用卡的方式進行付款喔！💳'
        });
        continue;
      }

      // 4. 關鍵字優先匹配
      let matched = false;
      for (const [keys, response] of Object.entries(keywordResponses)) {
        if (keys.split('|').some(k => text.includes(k))) {
          await client.pushMessage(userId, {type: 'text', text: response});
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // 5. 送洗進度特殊處理
      if (["洗好", "洗好了嗎", "可以拿了嗎", "進度", "好了嗎", "完成了嗎"].some(k => text.includes(k))) {
        await client.pushMessage(userId, {
          type: 'text',
          text: '營業時間會馬上查詢您的清洗進度😊，並回覆您！或是您可以這邊線上查詢 C.H精緻洗衣 謝謝您🔍',
          quickReply: { items: [{ type: "action", action: { type: "uri", label: "C.H精緻洗衣", uri: "https://liff.line.me/2004612704-JnzA1qN6#/" } }] }
        });
        continue;
      }

      // 6. 嚴格禁止AI回答時間相關問題
      const timeKeywords = ["天數", "工作日", "工作天", "工作日期限", "需要幾天", "幾天", "何時完成"];
      if (timeKeywords.some(k => text.includes(k))) continue;

      // 7. 其他問題交由AI（嚴格限制回答格式）
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

      // 8. 嚴格過濾AI回答
      const aiText = aiResponse.choices[0].message.content;
      if (!aiText || aiText.includes('無法回答') || timeKeywords.some(k => aiText.includes(k))) continue;

      await client.pushMessage(userId, {type: 'text', text: aiText});
    }
  } catch (err) {
    console.error('全局錯誤:', err);
  }
});

// ============== 啟動服務 ==============
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`服務運行中，端口：${port}`));
