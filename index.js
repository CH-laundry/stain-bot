const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

// LINE 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);
const app = express();

// 處理圖片訊息
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    const event = events[0];

    if (event.type === 'message' && event.message.type === 'image') {
      const imageId = event.message.id;
      const imageUrl = `https://api-data.line.me/v2/bot/message/${imageId}/content`;

      // 下載圖片
      const imageResponse = await axios.get(imageUrl, {
        headers: { Authorization: `Bearer ${config.channelAccessToken}` },
        responseType: 'arraybuffer'
      });

      // 轉換為 Base64
      const imageBase64 = Buffer.from(imageResponse.data, 'binary').toString('base64');

      // 調用 OpenAI GPT-4 Vision
      const openaiResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: "gpt-4-vision-preview",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "請分析這張圖片的污漬類型（例如油漬、紅酒漬、黃斑、發霉），並用中文回覆。格式範例：'污漬類型：油漬。清潔成功率：75%。建議方法：使用洗碗精和溫水擦拭。'"
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${imageBase64}`
                  }
                }
              ]
            }
          ],
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 25000 // 25 秒超時
        }
      ).catch(error => {
        console.error("OpenAI 請求失敗:", error.message);
        return null;
      });

      if (!openaiResponse) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '分析超時，請重試或提供更清晰的圖片。'
        });
        return res.sendStatus(200);
      }

      // 回覆分析結果
      const replyText = openaiResponse.data.choices[0].message.content;
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText
      });
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("全局錯誤:", error);
    res.sendStatus(200); // 必須回傳 200 給 LINE
  }
});

// 全局錯誤處理
app.use((err, req, res, next) => {
  console.error("全局錯誤捕獲:", err.stack);
  res.status(500).send('伺服器錯誤');
});

// 啟動伺服器
app.listen(process.env.PORT || 3000, () => {
  console.log(`伺服器運行中，端口: ${process.env.PORT}`);
});

// 健康檢查路由
app.get('/', (req, res) => {
  res.send('汙漬分析機器人運行中！');
}); 
