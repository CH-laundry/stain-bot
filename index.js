require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const keywordRules = require('./keywordRules');
const AddressDetector = require('./addressDetector');
const { handleDynamicReceiving } = require('./dynamicReply');
const SheetsReply = require('./sheetsReply');
const crypto = require('crypto');

const app = express();

// ✅ 確保環境變數存在
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const sheetsReply = new SheetsReply();

// 初始化Sheets数据
(async () => {
  try {
    await sheetsReply.loadData();
    console.log('✅ Google Sheets数据加载成功');
    
    // 设置定期更新
    setInterval(async () => {
      try {
        await sheetsReply.loadData();
        console.log('✅ Google Sheets数据已更新');
      } catch (error) {
        console.error('❌ Google Sheets数据更新失败:', error);
      }
    }, 30 * 60 * 1000); // 每30分钟更新一次
  } catch (error) {
    console.error('❌ 初始化Google Sheets数据失败:', error);
  }
})();

// ✅ 從 Google Sheets 讀取關鍵字回應
async function fetchSheetsData() {
  try {
    const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
    const API_KEY = process.env.SHEETS_API_KEY;
    
    // Google Sheets API 讀取網址
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/回應表!A:B?key=${API_KEY}`;
    
    const res = await axios.get(url);
    const rows = res.data.values;

    if (!rows || rows.length === 0) {
      console.error('❌ 沒有讀取到 Google Sheets 數據');
      return [];
    }

    return rows.map(row => ({ keyword: row[0], response: row[1] }));
  } catch (error) {
    console.error('❌ Google Sheets 讀取失敗:', error);
    return [];
  }
}

// ✅ 處理 LINE 訊息
async function handleMessage(event) {
  try {
  const userProfile = await client.getProfile(event.source.userId);
  const userName = userProfile.displayName;
  const text = event.message.text;

    console.log(`收到消息 - 用户: ${userName}, 内容: ${text}`);

  // 🔍 若使用者名稱包含地址，並且內容有「送回」「送還」「拿回來」，則回應地址
    if (AddressDetector.isAddress(userName) && /(送回|送還|拿回來)/.test(text)) {
      const replyMsg = AddressDetector.formatResponse(userName);
    return client.replyMessage(event.replyToken, { type: 'text', text: replyMsg });
  }

    // 1. 首先检查是否在Sheets中有匹配的回复
    const sheetsResponse = sheetsReply.getReply(text);
    if (sheetsResponse && sheetsResponse !== '📥 已记录问题将转交客服处理') {
      return client.replyMessage(event.replyToken, { type: 'text', text: sheetsResponse });
    }

    // 2. 如果Sheets没有匹配，检查动态收送回复
    if (/(收件|取件|來拿|幫忙收|幫忙拿|預約|送來|送出|要洗|來收|來取|送洗)/.test(text)) {
      const dynamicResponse = handleDynamicReceiving(text);
      return client.replyMessage(event.replyToken, { type: 'text', text: dynamicResponse });
    }

    // 3. 检查关键字规则
  for (let rule of keywordRules) {
    if (rule.keywords.some(keyword => text.includes(keyword))) {
        const response = typeof rule.response === 'function' 
          ? rule.response(text) 
          : rule.response;
        return client.replyMessage(event.replyToken, { type: 'text', text: response });
      }
    }

    // 4. 检查是否与洗衣相关
    if (isLaundryRelatedText(text)) {
  return client.replyMessage(event.replyToken, { 
    type: 'text', 
    text: '您可以參考我們的常見問題或按『3』😊，詳細問題營業時間內線上客服會跟您回覆，謝謝您！🙏😊'
  });
}

    // 5. 如果与洗衣无关，不回应
    console.log('消息与洗衣无关，不回应');
    return;
  } catch (error) {
    console.error('处理消息时出错:', error);
    // 出错时不回应，避免系统错误暴露给用户
    return;
  }
}

// 添加body-parser中间件
app.use(express.json());

// ✅ 設置 Webhook
app.post('/webhook', (req, res, next) => {
  try {
    console.log('\n=== Webhook Request Debug ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Raw Body:', req.body);
    
    // 手动验证签名
    const signature = req.headers['x-line-signature'];
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const body = JSON.stringify(req.body);
    
    if (!signature) {
      throw new Error('No signature provided');
    }
    
    if (!channelSecret) {
      throw new Error('No channel secret configured');
    }
    
    const expectedSignature = crypto
      .createHmac('SHA256', channelSecret)
      .update(Buffer.from(body))
      .digest('base64');
      
    console.log('\n=== Signature Verification ===');
    console.log('Channel Secret:', channelSecret);
    console.log('Request Body:', body);
    console.log('Expected Signature:', expectedSignature);
    console.log('Received Signature:', signature);
    console.log('Signatures Match:', expectedSignature === signature);
    
    if (expectedSignature !== signature) {
      throw new Error('Signature validation failed');
    }
    
    next();
  } catch (error) {
    console.error('\n=== Error in Webhook Middleware ===');
    console.error('Error:', error);
    res.status(400).json({ error: error.message });
  }
}, async (req, res) => {
  try {
  const events = req.body.events;
    if (!events || !Array.isArray(events)) {
      throw new Error('Invalid events format');
    }
    
  await Promise.all(events.map(event => {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    return handleMessage(event);
  }));

  res.status(200).end();
  } catch (error) {
    console.error('\n=== Error in Message Handler ===');
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============== 強制不回應列表 ==============
const ignoredKeywords = ["常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析", "謝謝", "您好", "按錯"];

// 检查文本是否与洗衣相关
function isLaundryRelatedText(text) {
    const lowerText = text.toLowerCase();
    const keywords = [
        "洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾", 
        "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", 
        "書包", "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約",
        "價格", "价錢", "收費", "費用", "多少錢", "價位", "算錢", "清洗費", "價目表"
    ];
    
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器已啟動在 http://localhost:${PORT}`);
});


