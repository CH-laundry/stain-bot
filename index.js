// ============== 使用次數檢查 ==============
async function checkUsage(userId) {
  // 如果是 ADMIN 用戶，直接返回 true（無限制）
  if (process.env.ADMIN && process.env.ADMIN.includes(userId)) {
    return true;
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const key = `usage:${userId}`;

  try {
    // 獲取用戶的使用記錄
    const usageRecords = await redisClient.lRange(key, 0, -1);

    // 過濾出在時間週期內的記錄
    const validRecords = usageRecords.filter(record => {
      const recordTime = parseInt(record);
      return currentTime - recordTime <= process.env.MAX_USES_TIME_PERIOD;
    });

    // 如果超過限制，返回 false
    if (validRecords.length >= process.env.MAX_USES_PER_USER) {
      return false;
    }

    // 添加新的使用記錄
    await redisClient.rPush(key, currentTime.toString());

    return true;
  } catch (err) {
    console.error("檢查使用次數時出錯:", err);
    return false;
  }
}

// ============== 動態表情符號 ==============
const dynamicEmojis = {
  "洗鞋": "👟",
  "窗簾": "🪟",
  "衣服": "👕",
  "包包": "👜",
  "沙發": "🛋️",
  "地毯": "🧹"
};

// ============== 關鍵字回應系統 ==============
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
  "醬油": "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶",
  "多少錢|費用|洗這個多少|怎麼收費|怎麼算": "可以參考我們的服務價目表，包包類或其他衣物可以跟我們說，另外跟您回覆，謝謝您！",
  "寶寶汽座|汽座|兒童座椅|兒童安全座椅|手推車|單人推車|單人手推車|雙人推車|寶寶手推車": "寶寶汽座&手推車"
};

// ============== 急件模糊關鍵字檢查 ==============
function isUrgentInquiry(text) {
  const urgentKeywords = ["急件", "加急", "趕時間", "快一點", "盡快", "緊急"];
  return urgentKeywords.some(keyword => text.includes(keyword));
}

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

        // 1. 急件模糊關鍵字檢查
        if (isUrgentInquiry(text)) {
          if (text.includes("3天") || text.includes("三天")) {
            await client.pushMessage(userId, {
              type: 'text',
              text: '不好意思，清潔需要一定的工作日，可能會來不及😢。'
            });
          } else {
            await client.pushMessage(userId, {
              type: 'text',
              text: '不好意思，清潔是需要一定的工作日，這邊客服會再跟您確認⏳。'
            });
          }
          continue;
        }

        // 2. 關鍵字優先匹配
        let matched = false;
        for (const [keys, response] of Object.entries(keywordResponses)) {
          if (keys.split('|').some(k => text.includes(k))) {
            await client.pushMessage(userId, { type: 'text', text: response });
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // 3. 未設置關鍵字的自動回應
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

        // 4. 嚴格過濾AI回答
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