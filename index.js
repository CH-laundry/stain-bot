const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);
const app = express();

// 強化日誌中間件
app.use(express.json());
app.use((req, res, next) => {
  console.log("收到請求:", req.method, req.path);
  next();
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    console.log("收到事件數組:", events);

    if (!events || events.length === 0) {
      console.log("空事件，忽略處理");
      return res.sendStatus(200);
    }

    const event = events[0];
    console.log("處理事件類型:", event.type);

    if (event.type === 'message' && event.message.type === 'image') {
      const imageId = event.message.id;
      const imageUrl = `https://api-data.line.me/v2/bot/message/${imageId}/content`;
      console.log("開始下載圖片:", imageUrl);

      const imageResponse = await axios.get(imageUrl, {
        headers: { 
          Authorization: `Bearer ${config.channelAccessToken}`,
          'User-Agent': 'StainBot/1.0'
        },
        responseType: 'arraybuffer'
      });
      console.log("圖片下載完成，大小:", imageResponse.data.length);

      const imageBase64 = Buffer.from(imageResponse.data, 'binary').toString('base64');
      console.log("Base64 轉換完成");

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
          max_tokens: 250
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v1'
          },
          timeout: 25000
        }
      ).catch(error => {
        console.error("OpenAI 請求失敗詳情:", {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
        return null;
      });

      if (!openaiResponse) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '分析服務暫時不可用，請稍後重試。'
        });
        return res.sendStatus(200);
      }

      console.log("OpenAI 回覆:", openaiResponse.data);
      const replyText = openaiResponse.data.choices[0].message.content;

      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText
      });
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("全局捕獲錯誤:", {
      message: error.message,
      stack: error.stack
    });
    res.sendStatus(200);
  }
});

// 其他保持不變...