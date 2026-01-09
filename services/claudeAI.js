// ====================================
// C.H 精緻洗衣 - Claude AI 智能客服模組
// 版本：完整版（Haiku 4.5 + 禮貌回覆 + 學習記錄）
// 目標：準確率 >90%、成本 <NT$ 400/月
// ====================================

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { google } = require('googleapis');

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Google Sheets 認證
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ====================================
// 業務知識庫（精簡版 - 降低成本）
// ====================================
const LAUNDRY_KNOWLEDGE = `
你是 C.H 精緻洗衣的專業客服助理。

【核心原則】
1. 禮貌專業、簡潔親切
2. 只回答洗衣相關問題
3. 無關問題回覆：UNRELATED
4. 不提供電話號碼
5. **不詢問客戶地址**（我們都有記錄）
6. 適度使用 💙 emoji

【特殊情況處理 - 非常重要！】

🔴 情況 1：客人催件或抱怨太慢
觸發詞：「怎麼洗這麼久」「已經超過時間」「什麼時候好」「還沒好嗎」「洗很久」「這麼慢」

回覆模板：
「非常抱歉讓您久等了 🙏

因為我們清潔完會仔細檢查品質，確認沒問題後會再次細部清潔，這樣才能確保最好的清潔效果 💙

您的衣物我們會盡快完成，好了會馬上跟您通知，謝謝您的耐心 🙏」

🔴 情況 2：客人抱怨忘記收件
觸發詞：「忘記來收了」「還沒來收」「是不是忘了」「怎麼還沒來」「沒來收」

回覆模板：
「非常抱歉！我們立即為您處理 🙏

麻煩您再次提供地址，我們會馬上安排收件

再次向您致歉，感謝您的包容 💙」

🔴 情況 3：客人不滿意或客訴
觸發詞：「不滿意」「生氣」「太差」「很爛」「退費」

回覆模板：
「非常抱歉造成您的困擾 🙏

我們會立即為您處理並改進
麻煩您告訴我們具體的問題

我們會盡力讓您滿意，謝謝您 💙」

【基本資訊】
- 營業時間：每日 10:30-20:00（週六公休）
- 完工時間：7-10 個工作日
- 付款方式：現金、轉帳、LINE PAY、ECPay

【價格表 - 精簡版】

衣物類：
- 襯衫/T-SHIRT：88元、女上衣：90元、背心：100元
- 針織衫：110元、女長版衣：130元、毛衣：150元
- 夾克/外套：200元、夾克(厚)：300元
- 大衣：320元、大衣(長)：380元
- 西裝(兩截)：230元、西裝(毛料)：300元
- 羽絨衣/Gore-Tex：330元、羽絨大衣(長)：400元
- 短褲：90元、長褲/西裝褲：120元、七分褲：110元
- 吊帶褲：140元、短裙：130元、長裙：160元
- 百褶裙：170元、百褶裙(長)：220元
- 短洋裝：230元、長洋裝：270元

精品衣物額外費用：
- 上衣/褲裙類精品：+150元（Gucci T-shirt、Chanel褲子等）
- 大衣/外套類精品：+250元（Canada Goose、Moncler等）
- 當客人說「很貴」「萬元以上」也算精品

回覆格式：
「[品項]：NT$ [基本價] 元
因為是精品衣物會特別處理，額外費用 + NT$ [150或250] 元
總計：NT$ [總價] 元 💙」

包包類：
- 長/短夾：300-600元、休閒包：500-800元、皮質包：600-1000元
- 精品名牌包（LV、Gucci、Chanel等）：
  * 問「能洗嗎」→「有的💙精品包我們有專業清洗服務」
  * 問「多少錢」→「這邊會由專人跟您回覆，謝謝您💙」

鞋類：
- 運動鞋：300元/350元（麂皮）
- 高價運動鞋(5000元以上)：400元/450元
- 鞋面補色：400元/800元
- 防水護理/除臭護理：250元
- 熱縮膜包裝：200元

特殊項目：
- 寶寶手推車：1200元、汽座：900元
- 地毯：依坪數計價（60×90cm起800元）

【到府收送】
江子翠：1件免費收送
其他區域：3件或滿500元免費收送

當天收件規則：
- 板橋地區 + 下午6點前 → 「好的💙」
- 其他情況 → 「好的💙 明天會去收」
- 週六 → 「因為週六固定公休，明天會去收回的💙」

【送回時間協調 - 重要！】
當客人說「送到家」「約時間」「方便協調」→ 這是送回時間，不是收件！
正確回覆：「好的💙 完工後我們會提前聯絡您約送回時間」

【常見問題】
Q: 清洗要多久？
A: 完工時間約 7-10 個工作日

Q: 洗好了嗎？
A: 您可以線上查詢 C.H精緻洗衣🔍
   https://liff.line.me/2004612704-JnzA1qN6#/home

Q: 汙漬能洗掉嗎？
A: 好！我們會針對汙漬加強處理💙
   ⚠️ 重要提醒：汙漬處理【不保證能完全去除】

【回覆原則】
1. 簡潔親切，適度使用💙
2. 不主動報價格（除非問）
3. 不主動說完工時間（除非問）
4. 根據對話記憶判斷上下文
5. 遇到催件/客訴，使用禮貌模板
6. 區分「收件」和「送回」
`;

// ====================================
// 對話記憶
// ====================================
const conversationHistory = new Map();
const pickupRepliedUsers = new Map();

// 清理過期記憶（30分鐘）
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of conversationHistory.entries()) {
    if (now - data.lastUpdate > 30 * 60 * 1000) {
      conversationHistory.delete(userId);
    }
  }
  for (const [userId, timestamp] of pickupRepliedUsers.entries()) {
    if (now - timestamp > 30 * 60 * 1000) {
      pickupRepliedUsers.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// 加入對話記錄（只保留 6 則）
function addToHistory(userId, role, content) {
  if (!userId) return;
  
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, {
      messages: [],
      lastUpdate: Date.now()
    });
  }
  
  const data = conversationHistory.get(userId);
  data.messages.push({ role, content });
  data.lastUpdate = Date.now();
  
  // 只保留最近 6 則（3 組對話）- 節省成本
  if (data.messages.length > 6) {
    data.messages = data.messages.slice(-6);
  }
}

// 取得對話記錄
function getHistory(userId) {
  if (!userId || !conversationHistory.has(userId)) {
    return [];
  }
  return conversationHistory.get(userId).messages;
}

// ====================================
// 記錄到 Google Sheets
// ====================================
async function logToGoogleSheets(userId, userMessage, aiReply, questionType = '', customerEmotion = '') {
  try {
    if (!process.env.LEARNING_SHEET_ID) {
      console.log('⚠️ 未設定 LEARNING_SHEET_ID，跳過記錄');
      return;
    }

    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    const now = new Date();
    const date = now.toLocaleDateString('zh-TW');
    const time = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.LEARNING_SHEET_ID,
      range: '對話記錄!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          date,
          time,
          userId,
          userMessage,
          aiReply,
          questionType,
          customerEmotion,
          '⏳ 待確認' // 等你標記
        ]]
      }
    });
    
    console.log('✅ 已記錄到 Google Sheets');
  } catch (error) {
    console.error('❌ Google Sheets 記錄失敗:', error.message);
  }
}

// ====================================
// 偵測客戶情緒
// ====================================
function detectEmotion(message) {
  const angry = ['生氣', '很爛', '太差', '退費', '不滿意'];
  const impatient = ['怎麼這麼久', '洗這麼久', '還沒好', '太慢', '很久'];
  const complaint = ['忘記', '還沒來', '怎麼還沒', '是不是忘了'];
  
  if (angry.some(word => message.includes(word))) return '😠 生氣';
  if (impatient.some(word => message.includes(word))) return '😤 不耐煩';
  if (complaint.some(word => message.includes(word))) return '😤 不耐煩';
  return '😊 正常';
}

// ====================================
// 偵測問題類型
// ====================================
function detectQuestionType(message) {
  if (/多少錢|價格|價錢|費用/.test(message)) return '價格詢問';
  if (/收|來收|收件/.test(message)) return '收件問題';
  if (/送到家|送回|約時間/.test(message)) return '送回問題';
  if (/汙漬|髒|油漬|血/.test(message)) return '汙漬處理';
  if (/怎麼這麼久|還沒好|太慢/.test(message)) return '催件';
  if (/忘記|還沒來/.test(message)) return '客訴';
  if (/地毯|窗簾|包包|鞋/.test(message)) return '特殊項目';
  return '其他';
}

// ====================================
// 處理文字訊息（Claude AI）
// ====================================
async function handleTextMessage(userMessage, userId = null) {
  try {
    console.log('📩 收到訊息:', userMessage);
    
    // 過濾 6宮格模板
    const exactMatches = [
      '到府收送', '常見問題', '付款方式', '常見問題&付款方式',
      '服務價目', '儲值優惠', '服務價目&儲值優惠',
      '店面地址', '營業時間', '店面地址&營業時間',
      '智能污漬分析', '智能汙漬分析', '寶寶汽座&手推車', '顧客須知'
    ];
    
    const partialMatches = [
      '預約收送,請提供以下訊息', '以利小幫手為您服務',
      '收件件數:', '感謝您🤗', '江翠北芳鄰無件數限制'
    ];
    
    if (exactMatches.includes(userMessage.trim())) {
      return null;
    }
    
    if (partialMatches.some(phrase => userMessage.includes(phrase))) {
      return null;
    }
    
    // 檢查收件問題記憶
    const isPickupQuestion = /收|來收|收件|到府|收衣|收送/.test(userMessage);
    if (isPickupQuestion && userId && pickupRepliedUsers.has(userId)) {
      console.log('🔇 已回覆過收件問題');
      return null;
    }
    
    // 取得當前時間
    const now = new Date();
    const taipeiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const currentHour = taipeiTime.getHours();
    const currentDay = taipeiTime.getDay();
    const dayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const timeInfo = `當前時間：${dayNames[currentDay]} ${currentHour}:${taipeiTime.getMinutes().toString().padStart(2, '0')}`;
    
    // 取得對話記錄
    const history = getHistory(userId);
    const messages = [];
    
    history.forEach(msg => {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    });
    
    messages.push({
      role: "user",
      content: `${timeInfo}\n\n客人問題：${userMessage}`
    });
    
    // 呼叫 Claude API（使用 Haiku 4.5 - 便宜！）
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-20250514", // ⭐ 使用 Haiku 4.5（成本只有 Sonnet 的 1/5）
      max_tokens: 800, // 降低 token 數量節省成本
      system: LAUNDRY_KNOWLEDGE,
      messages: messages
    });

    const claudeReply = message.content[0].text;

    if (claudeReply.includes('UNRELATED')) {
      return null;
    }

    // 儲存對話記錄
    addToHistory(userId, "user", userMessage);
    addToHistory(userId, "assistant", claudeReply);

    // 記住收件問題
    if (isPickupQuestion && userId && claudeReply) {
      pickupRepliedUsers.set(userId, Date.now());
    }

    // 偵測情緒和問題類型
    const emotion = detectEmotion(userMessage);
    const questionType = detectQuestionType(userMessage);

    // 記錄到 Google Sheets
    await logToGoogleSheets(userId, userMessage, claudeReply, questionType, emotion);

    return claudeReply;

  } catch (error) {
    console.error('[Claude AI] 錯誤:', error);
    
    // 錯誤時的友善回覆
    return '不好意思，系統暫時忙碌中，請稍後再試或營業時間會有專人回覆您 🙏';
  }
}

// ====================================
// 處理圖片訊息（OpenAI 汙漬分析）
// ====================================
async function handleImageMessage(imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: "請分析這張衣物照片上的汙漬類型，並建議清洗方式。請用繁體中文簡潔回答，包含：1)汙漬類型 2)建議處理方式 3)預估清洗效果（但要說明不保證完全去除）" 
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 500
    });

    const analysis = response.choices[0].message.content;

    return `🔍 AI 汙漬分析結果

${analysis}

⚠️ 重要提醒：
汙漬處理【不保證能完全去除】
實際清洗效果需由專業師傅評估

C.H 精緻洗衣 💙`;

  } catch (error) {
    console.error('[OpenAI] 錯誤:', error);
    return '感謝您提供照片！我們的專業師傅會仔細評估汙漬狀況 💙';
  }
}

module.exports = {
  handleTextMessage,
  handleImageMessage
};
