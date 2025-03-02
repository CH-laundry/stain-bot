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

        // 1. 檢查是否為寶寶汽座或手推車相關問題
        const babyKeywords = ["寶寶汽座", "汽座", "兒童座椅", "兒童安全座椅", "手推車", "單人推車", "單人手推車", "雙人推車", "寶寶手推車"];
        if (babyKeywords.some(keyword => text.includes(keyword))) {
          await client.pushMessage(userId, { type: 'text', text: '寶寶汽座&手推車' });
          continue;
        }

        // 2. 啟動智能污漬分析
        if (text === '1') {
          startup_store.set(userId, Date.now() + 180e3); // 設置 3 分鐘的有效期
          console.log(`用戶 ${userId} 開始使用`);
          await client.pushMessage(userId, { type: 'text', text: '請上傳圖片以進行智能污漬分析📸' });
          continue;
        }

        // 3. 關鍵字優先匹配
        let matched = false;
        for (const [keys, response] of Object.entries(keywordResponses)) {
          if (keys.split('|').some(k => text.includes(k))) {
            await client.pushMessage(userId, { type: 'text', text: response });
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // 4. 送洗進度特殊處理
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

        // 5. 其他問題交由AI（嚴格限制回答格式）
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

        // 6. 嚴格過濾AI回答
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