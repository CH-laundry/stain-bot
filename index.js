async function getAIResponse(userMessage) {
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "你是一個洗衣店客服機器人，請用簡潔明確的方式回答客戶的問題，不要提供額外的清洗建議。例如：\n客戶：可以洗窗簾嗎？\n回應：可以的，我們有窗簾清潔服務喔！\n\n客戶：這件衣服洗得掉嗎？\n回應：我們會盡力處理，但成功率視污漬與材質而定。\n\n請以這種簡潔格式回答問題。" },
        { role: "user", content: userMessage }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("❌ OpenAI API 失敗: ", error);
    return "目前客服系統繁忙，請稍後再試 🙏";
  }
}

// **WebHook，確保圖片分析功能完全不變**
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // 確保 LINE 收到回調

  try {
    const events = req.body.events;
    console.log(JSON.stringify(events, null, 2));

    for (const event of events) {
      if (event.type !== 'message' || !event.source.userId) continue;

      const userId = event.source.userId;

      // **處理文字訊息**
      if (event.message.type === 'text') {
        const text = event.message.text.trim().toLowerCase();

        console.log(`📝 收到文字訊息: ${text}`);

        // **呼叫 AI 客服（確保 API 錯誤時不影響整體運行）**
        const responseMessage = await getAIResponse(text);
        await client.pushMessage(userId, { type: 'text', text: responseMessage });
        continue;
      }

      // **圖片分析部分完全不變**
      if (event.message.type === 'image') {
        try {
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

          // **調用 OpenAI API 進行圖片分析（與原本一模一樣，不變動格式）**
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

          // **回覆圖片分析結果（與原本格式一模一樣）**
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
