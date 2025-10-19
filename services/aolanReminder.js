// 最簡單測試：只推一則訊息到你自己的 LINE
require('dotenv').config();
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

async function sendLineMessage(text) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: LINE_USER_ID, messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('✅ 成功發送 LINE 通知');
  } catch (err) {
    console.error('❌ LINE 發送失敗:', err.response?.data || err.message);
  }
}

sendLineMessage('✅ 測試成功：這是 C.H 精緻洗衣自動通知測試 💙');
