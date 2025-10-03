const { Client } = require('@line/bot-sdk');

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const userId = "U599169723d6e83588c5f23dfa..."; // ← 換成你剛剛印到的 userId

client.pushMessage(userId, {
  type: 'text',
  text: '✅ 測試推播成功！這是一則主動訊息 🚀'
}).then(() => {
  console.log("訊息已送出");
}).catch(err => {
  console.error("推播錯誤", err);
});

