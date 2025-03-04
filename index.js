// ============== 強制不回應列表 ==============
const ignoredKeywords = ["常見問題", "服務價目&儲值優惠", "到府收送", "店面地址&營業時間", "付款方式", "寶寶汽座&手推車", "顧客須知", "智能污漬分析", "謝謝", "您好", "按錯"];

// ============== 引入依賴 ==============
const express = require('express');
const { createHash } = require('crypto');
const { Client } = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// 初始化 Express 應用程式
const app = express();
app.use(express.json());

// 初始化 LINE 客戶端
const client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
});

// 初始化 OpenAI 客戶端
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// 用戶狀態存儲
const userState = {};
const store = new Map();

// 設置最大使用次數和時間週期
const MAX_USES_PER_USER = process.env.MAX_USES_PER_USER || 2;
const MAX_USES_TIME_PERIOD = process.env.MAX_USES_TIME_PERIOD || 604800; // 604800秒為一周

// ============== KEY_VALUE 回應列表 ==============
const KEY_VALUE_RESPONSES = {
    "營業時間": {
        "zh-TW": "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊",
        "zh-CN": "今日有营业的💖我们的营业时间为 10:30 - 20:00，除周六固定公休喔！😊",
        "en": "We are open today! 💖 Our business hours are 10:30 AM - 8:00 PM, except for Saturdays when we are closed. 😊",
        "ja": "本日は営業しております💖営業時間は10:30～20:00です。土曜日は定休日です😊"
    },
    "到府收送服務": {
        "zh-TW": "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕",
        "zh-CN": "我们有免费到府收送服务📦，可以 LINE 或官网预约喔！🚚 江翠北芳邻一件就可以免费收送，板桥、新庄、三重、中和、永和满三件或 500 元，放置管理室跟我们说就可以了！👕",
        "en": "We offer free pick-up and delivery service! 📦 You can make a reservation via LINE or our official website! 🚚 Free pick-up and delivery for Jiangcui North Neighborhood for one item, and for Banqiao, Xinzhuang, Sanchong, Zhonghe, and Yonghe, it's free for 3 items or $500. Just leave it at the management office and let us know! 👕",
        "ja": "無料の集荷・配達サービスがございます📦LINEまたは公式サイトからご予約ください！🚚 江翠北芳鄰は1点から無料集配、板橋、新莊、三重、中和、永和は3点または500元以上で無料です。管理人室に置いていただければ結構です！👕"
    },
    "清洗服務": {
        "zh-TW": "我們提供各式衣物、包包、地毯等清洗服務，您可以告訴我們具體需求，我們會根據狀況安排清洗。🧹",
        "zh-CN": "我们提供各式衣物、包包、地毯等清洗服务，您可以告诉我们具体需求，我们会根据状况安排清洗。🧹",
        "en": "We provide cleaning services for various items such as clothes, bags, carpets, etc. Please let us know your specific needs, and we will arrange cleaning based on the situation. 🧹",
        "ja": "衣類、バッグ、カーペットなど、様々なクリーニングサービスを提供しております。具体的なご要望をお知らせいただければ、状況に応じてクリーニングを手配いたします。🧹"
    },
    "清潔時間": {
        "zh-TW": "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳",
        "zh-CN": "我们的清洁时间一般约 7-10 个工作天⏰，完成后会自动通知您喔！谢谢您⏳",
        "en": "Our cleaning time is generally about 7-10 business days ⏰. We will automatically notify you when it's done! Thank you ⏳",
        "ja": "クリーニング時間は通常7～10営業日です⏰完了したら自動的にお知らせします。ありがとうございます⏳"
    },
    "查詢清洗進度": {
        "zh-TW": "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍",
        "zh-CN": "营业时间会马上查询您的清洗进度😊，并回复您！谢谢您🔍",
        "en": "During business hours, we will immediately check your cleaning progress 😊 and reply to you! Thank you 🔍",
        "ja": "営業時間内にクリーニングの進捗状況を確認し、すぐにご返信いたします😊ありがとうございます🔍"
    },
    "清洗完成送回": {
        "zh-TW": "清洗完成後會送回給您，送達時也會通知您喔！🚚",
        "zh-CN": "清洗完成后会送回给您，送达时也会通知您喔！🚚",
        "en": "After cleaning is complete, we will deliver it back to you and notify you upon arrival! 🚚",
        "ja": "クリーニング完了後、お届けし、到着時にお知らせします！🚚"
    },
    "清洗完成拿回": {
        "zh-TW": "衣物清洗完成後會送回，請放心！😄",
        "zh-CN": "衣物清洗完成后会送回，请放心！😄",
        "en": "Your clothes will be delivered back after cleaning, please rest assured! 😄",
        "ja": "衣類のクリーニング完了後、お届けしますのでご安心ください！😄"
    },
    "油漬處理": {
        "zh-TW": "油漬我們有專門的處理方式，大部分都可以變淡，請放心！🍳",
        "zh-CN": "油渍我们有专门的处理方式，大部分都可以变淡，请放心！🍳",
        "en": "We have special treatments for oil stains, most of them can be lightened, please rest assured! 🍳",
        "ja": "油汚れには専門の処理方法があり、ほとんどの場合は薄くすることができますのでご安心ください！🍳"
    },
    "血漬處理": {
        "zh-TW": "血漬我們會盡力處理，但成功率視沾染時間和材質而定喔！💉",
        "zh-CN": "血渍我们会尽力处理，但成功率视沾染时间和材质而定喔！💉",
        "en": "We will try our best to deal with blood stains, but the success rate depends on the staining time and material! 💉",
        "ja": "血液のシミはできる限り対応しますが、成功率は付着時間と素材によって異なります！💉"
    },
    "醬油污漬處理": {
        "zh-TW": "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶",
        "zh-CN": "酱油污渍我们有专门的处理方式，大部分都可以变淡，请放心！🍶",
        "en": "We have special treatments for soy sauce stains, most of them can be lightened, please rest assured! 🍶",
        "ja": "醤油のシミには専門の処理方法があり、ほとんどの場合は薄くすることができますのでご安心ください！🍶"
    },
    "寶寶汽座清洗": {
        "zh-TW": "我們有清洗寶寶汽座，費用是 $900 👶",
        "zh-CN": "我们有清洗宝宝汽座，费用是 $900 👶",
        "en": "We clean baby car seats, the cost is $900 👶",
        "ja": "ベビーシートのクリーニングを行っております。料金は900ドルです👶"
    },
    "手推車清洗": {
        "zh-TW": "我們有清洗手推車，寶寶單人手推車費用是 $1200 🛒，雙人手推車費用是 $1800 🛒",
        "zh-CN": "我们有清洗手推车，宝宝单人手推车费用是 $1200 🛒，双人手推车费用是 $1800 🛒",
        "en": "We clean strollers, the cost for a single baby stroller is $1200 🛒, and for a double stroller is $1800 🛒",
        "ja": "ベビーカーのクリーニングを行っております。シングルベビーカーの料金は1200ドル🛒、二人乗りベビーカーの料金は1800ドルです🛒"
    },
    "書包清洗": {
        "zh-TW": "我們有清洗書包，費用是 $550 🎒",
        "zh-CN": "我们有清洗书包，费用是 $550 🎒",
        "en": "We clean backpacks, the cost is $550 🎒",
        "ja": "ランドセルのクリーニングを行っております。料金は550ドルです🎒"
    },
    "污漬處理": {
        "zh-TW": "我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨",
        "zh-CN": "我们会针对污渍做专门处理，大部分污渍都可以变淡，但成功率视污渍种类与衣物材质而定喔！✨",
        "en": "We will treat stains specifically, most stains can be lightened, but the success rate depends on the type of stain and the material of the clothing! ✨",
        "ja": "シミの種類に応じて専門的な処理を行い、ほとんどのシミは薄くすることができますが、成功率はシミの種類や衣類の素材によって異なります！✨"
    },
    "盡力污漬處理": {
        "zh-TW": "我們會盡力處理污漬，但滲透到纖維或時間較久的污漬可能無法完全去除，請見諒！😊",
        "zh-CN": "我们会尽力处理污渍，但渗透到纤维或时间较久的污渍可能无法完全去除，请见谅！😊",
        "en": "We will do our best to treat stains, but stains that have penetrated into the fibers or are old may not be completely removed, please understand! 😊",
        "ja": "シミの処理には最善を尽くしますが、繊維に浸透したシミや時間の経過したシミは完全に除去できない場合があります。ご了承ください！😊"
    },
    "染色問題處理": {
        "zh-TW": "染色問題我們會盡量處理，但如果滲透到衣物纖維或面積較大，不能保證完全處理喔！🌈",
        "zh-CN": "染色问题我们会尽量处理，但如果渗透到衣物纤维或面积较大，不能保证完全处理喔！🌈",
        "en": "We will try our best to deal with dyeing issues, but if it has penetrated into the clothing fibers or the area is large, complete removal cannot be guaranteed! 🌈",
        "ja": "染色の問題にはできる限り対応しますが、衣類の繊維に浸透していたり、面積が大きい場合は、完全に除去できるとは限りません！🌈"
    },
    "退色問題": {
        "zh-TW": "已經退色的衣物是無法恢復的，請見諒！🎨",
        "zh-CN": "已经退色的衣物是无法恢复的，请见谅！🎨",
        "en": "Clothes that have already faded cannot be restored, please understand! 🎨",
        "ja": "すでに色あせた衣類は元に戻せません。ご了承ください！🎨"
    },
    "地毯清洗服務詢價": {
        "zh-TW": "我們提供地毯清洗服務，請告知我們您需要清洗的地毯狀況，我們會跟您回覆清洗價格。🧹",
        "zh-CN": "我们提供地毯清洗服务，请告知我们您需要清洗的地毯状况，我们会跟您回复清洗价格。🧹",
        "en": "We provide carpet cleaning services. Please tell us the condition of the carpet you need to clean, and we will reply with the cleaning price. 🧹",
        "ja": "カーペットクリーニングサービスを提供しております。クリーニングが必要なカーペットの状態をお知らせください。クリーニング料金をお知らせいたします。🧹"
    },
    "窗簾清洗服務詢價": {
        "zh-TW": "我們提供窗簾清洗服務，請提供您的窗簾尺寸和材質，我們會跟您回覆清洗價格。🪟",
        "zh-CN": "我们提供窗帘清洗服务，请提供您的窗帘尺寸和材质，我们会跟您回复清洗价格。🪟",
        "en": "We provide curtain cleaning services. Please provide your curtain size and material, and we will reply with the cleaning price. 🪟",
        "ja": "カーテンクリーニングサービスを提供しております。カーテンのサイズと素材をお知らせください。クリーニング料金をお知らせいたします。🪟"
    },
    "提供衣物清洗服務": {
        "zh-TW": "我們提供各式衣物清洗服務，無論是衣服、外套、襯衫等都可以清洗。👕",
        "zh-CN": "我们提供各式衣物清洗服务，无论是衣服、外套、衬衫等都可以清洗。👕",
        "en": "We provide various clothing cleaning services, including clothes, coats, shirts, etc. 👕",
        "ja": "衣類、コート、シャツなど、様々な衣類のクリーニングサービスを提供しております。👕"
    }
};

// ============== 關鍵字指向 KEY_VALUE 回應 ==============
const keywordResponses = {
    "營業": "營業時間",
    "開門": "營業時間",
    "休息": "營業時間",
    "開店": "營業時間",
    "有開": "營業時間",
    "收送": "到府收送服務",
    "到府": "到府收送服務",
    "上門": "到府收送服務",
    "收衣": "到府收送服務",
    "預約": "到府收送服務",
    "清洗": "清洗服務",
    "洗多久": "清潔時間",
    "洗好": "查詢清洗進度",
    "洗好了嗎": "查詢清洗進度",
    "送回": "清洗完成送回",
    "拿回": "清洗完成拿回",
    "油漬": "油漬處理",
    "血漬": "血漬處理",
    "醬油": "醬油污漬處理",
    "寶寶汽座": "寶寶汽座清洗",
    "汽座": "寶寶汽座清洗",
    "手推車": "手推車清洗",
    "書包": "書包清洗",
    "洗的掉": "污漬處理",
    "洗掉": "盡力污漬處理",
    "染色": "染色問題處理",
    "退色": "退色問題",
    "地毯": "地毯清洗服務詢價",
    "有洗地毯": "地毯清洗服務詢價",
    "有清洗地毯": "地毯清洗服務詢價",
    "窗簾": "窗簾清洗服務詢價",
    "有洗窗簾": "窗簾清洗服務詢價",
    "有清洗窗簾": "窗簾清洗服務詢價",
    "是否能清洗衣物": "提供衣物清洗服務"
};

// ============== 語言檢測 ==============
function detectLanguage(text) {
    const japaneseRegex = /[\u3040-\u30ff\u31f0-\u31ff\u4e00-\u9faf]/; // Regex for Japanese characters
    const chineseRegex = /[\u4e00-\u9fff]/; // Regex for Chinese characters
    const englishRegex = /[a-zA-Z]/; // Basic regex for English characters

    if (japaneseRegex.test(text)) {
        return "ja";
    } else if (chineseRegex.test(text)) {
        // Further differentiate between Traditional and Simplified Chinese if needed.
        // For now, defaulting to Traditional Chinese (zh-TW) as it's more common in Taiwan.
        return "zh-TW";
    } else if (englishRegex.test(text)) {
        return "en";
    } else {
        return "zh-TW"; // Default to Traditional Chinese if language is not detected
    }
}


// ============== 使用次數檢查 ==============
async function checkUsage(userId) {
    const key = `rate_limit:user:${userId}`;
    const now = Date.now();
    const timePeriodMs = MAX_USES_TIME_PERIOD * 1000;

    try {
        let userActions = store.get(key);
        if (!userActions) {
            userActions = [];
        }

        // 移除過期的 action 时间戳
        userActions = userActions.filter(timestamp => timestamp > now - timePeriodMs);

        if (userActions.length < MAX_USES_PER_USER) {
            userActions.push(now); // 添加新的 action 时间戳
            store.set(key, userActions); // 更新 store
            return true; // 允许使用
        } else {
            return false; // 达到限制，拒绝使用
        }
    } catch (error) {
        console.error("Map 存储限流错误:", error);
        return true;
    }
}

// ============== 智能污漬分析 ==============
async function analyzeStain(userId, imageBuffer) {
    try {
        const base64Image = imageBuffer.toString('base64');
        const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

        console.log('圖片已接收，hash值:', imageHash);
        logToFile(`圖片已接收，hash值: ${imageHash}`);

        // 調用 OpenAI API 進行圖片分析（使用 GPT-4o 模型）
        const openaiResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `你是專業的精品清潔顧問，請按照以下格式分析圖片：
1. 以流暢口語化中文描述物品與污漬狀況
2. 清洗成功機率（精確百分比）
3. 品牌辨識（使用「可能為」、「推測為」等專業用語）
4. 材質分析（說明材質特性與清潔注意點）
5. 款式特徵（專業術語描述設計元素）
6. 若為精品包（如 Louis Vuitton、Chanel、Hermès 等），請提供年份與稀有性資訊（若可辨識）
7. 結尾統一使用：「我們會根據材質特性進行適當清潔，確保最佳效果。」

要求：
- 完全不用 ** 符號或任何標記
- 品牌/材質/款式資訊需明確且專業
- 若為精品包，需包含以下細節：
  - 品牌辨識依據（標誌/經典元素）
  - 材質組合（例：塗層帆布+皮革滾邊）
  - 特殊工藝（例：馬鞍縫線/金屬配件）
  - 年份與稀有性（若可辨識）
- 非精品包或無法辨識品牌時，不提年份與稀有性`
            }, {
                role: 'user',
                content: [
                    { type: 'text', text: '請分析此物品並提供專業清潔建議。' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                ]
            }]
        });

        // 取得分析結果並移除多餘符號
        let analysisResult = openaiResponse.choices[0].message.content
            .replace(/\*\*/g, '')
            .replace(/我們會以不傷害材質盡量做清潔處理。/g, '');

        // 確保結尾格式統一
        if (!analysisResult.endsWith('確保最佳效果。')) {
            analysisResult += '\n我們會根據材質特性進行適當清潔，確保最佳效果。';
        }

        // 回覆用戶
        await client.pushMessage(userId, {
            type: 'text',
            text: `${analysisResult}\n\n✨ 智能分析完成 👕`
        });

        // 美观地输出日志
        console.log(`\n--------------------------------------------------------`);
        console.log(`|  用戶 ${userId} 的圖片分析結果:`);
        console.log(`--------------------------------------------------------`);
        console.log(`${analysisResult}\n\n✨ 智能分析完成 👕`);

        logToFile(`用戶 ${userId} 的圖片分析結果:\n${analysisResult}\n✨ 智能分析完成 👕`);

    } catch (err) {
        console.error("OpenAI 服務出現錯誤:", err);
        logToFile(`OpenAI 服務出現錯誤: ${err}`);
        await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
    }
}

// ============== 判斷是否為付款方式詢問 ==============
function isPaymentInquiry(text) {
    const paymentKeywords = [
        "付款", "付費", "支付", "怎麼付", "如何付", "付錢",
        "付款", "付费", "支付", "怎么付", "如何付", "付钱", // Simplified Chinese
        "payment", "pay", "how to pay", "pay money", // English
        "支払い", "支払う", "支払い方法", "支払", "どうやって払う"  // Japanese
    ];
    return paymentKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為清洗方式詢問 ==============
function isWashMethodInquiry(text) {
    const washMethodKeywords = [
        "水洗", "乾洗", "如何清洗", "怎麼洗", "清潔方式",
        "水洗", "干洗", "如何清洗", "怎么洗", "清洁方式", // Simplified Chinese
        "wash method", "washing method", "how to wash", "water wash", "dry clean", // English
        "水洗い", "ドライクリーニング", "洗濯方法", "洗い方", "クリーニング方法" // Japanese
    ];
    return washMethodKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為清洗進度詢問 ==============
function isProgressInquiry(text) {
    const progressKeywords = [
        "洗好", "洗好了嗎", "進度", "好了嗎", "完成了嗎",
        "洗好", "洗好了吗", "进度", "好了吗", "完成了吗", // Simplified Chinese
        "done", "ready", "progress", "is it done", "is it ready", "status", // English
        "洗い上がり", "終わった", "進捗", "終わりましたか", "完了しましたか", "ステータス" // Japanese
    ];
    return progressKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為急件詢問 ==============
function isUrgentInquiry(text) {
    const urgentKeywords = [
        "急件", "趕件", "快一點", "加急", "趕時間",
        "1天", "2天", "3天", "一天", "兩天", "三天",
        "急件", "赶件", "快一点", "加急", "赶时间", // Simplified Chinese
        "urgent", "rush", "hurry", "fast", "quickly", "asap", "1 day", "2 days", "3 days", // English
        "急ぎ", "特急", "早く", "至急", "1日", "2日", "3日" // Japanese
    ];
    return urgentKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷價格詢問 ==============
function isPriceInquiry(text) {
    const priceKeywords = [
        "價格", "价錢", "收費", "費用", "多少錢", "價位", "算錢", "清洗費", "價目表",
        "這件多少", "這個價格", "鞋子費用", "洗鞋錢", "要多少", "怎麼算", "窗簾費用",
        "价格", "价钱", "收费", "费用", "多少钱", "价位", "算钱", "清洗费", "价目表", // Simplified Chinese
        "this much", "price", "cost", "fee", "how much", "price list", "charge", "shoes fee", "curtain fee", // English
        "値段", "価格", "料金", "費用", "いくら", "価格表", "靴の料金", "カーテンの料金", "いくらかかりますか" // Japanese
    ];
    return priceKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否為清洗時間詢問 ==============
function isCleaningTimeInquiry(text) {
    const cleaningTimeKeywords = [
        "清潔時間", "拿到", "洗要多久", "多久", "會好", "送洗時間",
        "清洁时间", "拿到", "洗要多久", "多久", "会好", "送洗时间", // Simplified Chinese
        "cleaning time", "get back", "how long to clean", "how long", "when will be ready", "delivery time", // English
        "クリーニング時間", "受け取り", "洗濯時間", "どのくらい", "いつできる", "配達時間" // Japanese
    ];
    return cleaningTimeKeywords.some(keyword => text.includes(keyword));
}

// ============== 判斷是否與洗衣店相關 ==============
function isLaundryRelated(text) {
    const laundryKeywords = [
        "洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾",
        "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", "書包",
        "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約", "洗多久", "洗好", "洗好了嗎", "送回", "拿回",
        "洗衣", "清洗", "污渍", "油渍", "血渍", "酱油", "染色", "退色", "地毯", "窗帘", // Simplified Chinese
        "宝宝汽座", "汽座", "儿童座椅", "安全儿童座椅", "手推车", "单人手推车", "宝宝手推车", "书包",
        "营业", "开门", "休息", "开店", "有开", "收送", "到府", "上门", "收衣", "预约", "洗多久", "洗好", "洗好了吗", "送回", "拿回",
        "laundry", "clean", "stain", "oil stain", "blood stain", "soy sauce", "dyeing", "fading", "carpet", "curtain", // English
        "baby car seat", "car seat", "child seat", "stroller", "baby stroller", "backpack",
        "open", "business hours", "pickup", "delivery", "collect clothes", "reservation", "how long to wash", "done", "ready", "return", "take back",
        "洗濯", "クリーニング", "汚れ", "油汚れ", "血", "醤油", "染色", "色落ち", "カーペット", "カーテン", // Japanese
        "ベビーシート", "チャイルドシート", "ベビーカー", "ランドセル",
        "営業", "開店", "休憩", "オープン", "集荷", "配達", "予約", "洗濯時間", "完了", "返却", "回収"
    ];
    return laundryKeywords.some(keyword => text.includes(keyword));
}

// ============== 日志記錄 ==============
const logFilePath = path.join(__dirname, 'logs.txt');

function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${message}\n`;

    fs.appendFile(logFilePath, logEntry, (err) => {
        if (err) {
            console.error('寫入日誌文件出錯:', err);
        }
    });
}

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
    res.status(200).end();

    try {
        const events = req.body.events;

        for (const event of events) {
            try {
                if (event.type !== 'message' || !event.source.userId) continue;

                const userId = event.source.userId;
                let userMessage = '';
                if (event.message.type === 'text') {
                    userMessage = event.message.text.trim();
                } else if (event.message.type === 'image') {
                    userMessage = '上傳了一張圖片';
                } else {
                    userMessage = '發送了其他類型的訊息';
                }

                // 記錄用戶ID和訊息內容
                console.log(`用戶 ${userId} 發送了訊息: ${userMessage}`);
                logToFile(`用戶 ${userId} 發送了訊息: ${userMessage} (User ID: ${userId})`);

                // 文字訊息
                if (event.message.type === 'text') {
                    const text = userMessage.toLowerCase(); // use the original userMessage to log to the file, use lowercase text for processing
                    const detectedLang = detectLanguage(userMessage); // Detect language

                    // 檢查是否包含強制不回應的關鍵字
                    const shouldIgnore = ignoredKeywords.some(keyword => text.includes(keyword.toLowerCase()));
                    if (shouldIgnore) {
                        console.log(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。`);
                        logToFile(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。(User ID: ${userId})`);
                        continue;
                    }

                    // 1. 按「1」啟動智能污漬分析
                    if (text === '1' || text === 'one' || text === 'いち') { // Added English and Japanese for '1'
                        // 檢查使用次數
                        const canUse = await checkUsage(userId);
                        if (!canUse) {
                            const responseText = KEY_VALUE_RESPONSES["查詢清洗進度"][detectedLang] || KEY_VALUE_RESPONSES["查詢清洗進度"]["zh-TW"]; // Fallback to zh-TW
                            await client.pushMessage(userId, { type: 'text', text: '您本週的使用次數已達上限，請下周再試。' });
                            console.log(`\n--------------------------------------------------------`);
                            console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                            console.log(`|  Bot 回覆用戶 ${userId}: 您本週的使用次數已達上限，請下周再試。`);
                            console.log(`--------------------------------------------------------\n`);
                            logToFile(`Bot 回覆用戶 ${userId}: 您本週的使用次數已達上限，請下周再試。(User ID: ${userId})`);
                            continue;
                        }

                        await client.pushMessage(userId, {
                            type: 'text',
                            text: '請上傳照片，以進行智能污漬分析✨📷'
                        });
                        userState[userId] = { waitingForImage: true };
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 請上傳照片，以進行智能污漬分析✨📷`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 請上傳照片，以進行智能污漬分析✨📷(User ID: ${userId})`);
                        continue;
                    }

                    // 2. 判斷付款方式詢問
                    if (isPaymentInquiry(text)) {
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: '我們可以現金💵、線上Line Pay📱、信用卡💳、轉帳🏦。'
                        });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 我們可以現金💵、線上Line Pay📱、信用卡💳、轉帳🏦。`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 我們可以現金💵、線上Line Pay📱、信用卡💳、轉帳🏦。(User ID: ${userId})`);
                        continue;
                    }

                    // 3. 判斷清洗方式詢問
                    if (isWashMethodInquiry(text)) {
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: '我們會依照衣物上的洗標來做清潔，也會判斷如何清潔，會以不傷害材質來清潔的✨👕。'
                        });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 我們會依照衣物上的洗標來做清潔，也會判斷如何清潔，會以不傷害材質來清潔的✨👕。`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 我們會依照衣物上的洗標來做清潔，也會判斷如何清潔，會以不傷害材質來清潔的✨👕。(User ID: ${userId})`);
                        continue;
                    }

                    // 4. 判斷清洗進度詢問
                    if (isProgressInquiry(text)) {
                        const responseText = KEY_VALUE_RESPONSES["查詢清洗進度"][detectedLang] || KEY_VALUE_RESPONSES["查詢清洗進度"]["zh-TW"]; // Fallback to zh-TW
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: responseText,
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
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: ${responseText}`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: ${responseText}(User ID: ${userId})`);
                        continue;
                    }

                    // 5. 判斷“能洗掉”的問題 (Added English and Japanese translations)
                    if (["洗的掉", "洗掉", "會洗壞", "洗的掉吗", "洗掉吗", "can be removed", "remove stain", "取れますか", "落とせますか"].some(k => text.includes(k))) {
                        const responseText = KEY_VALUE_RESPONSES["污漬處理"][detectedLang] || KEY_VALUE_RESPONSES["污漬處理"]["zh-TW"]; // Fallback to zh-TW
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: responseText
                        });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: ${responseText}`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: ${responseText}(User ID: ${userId})`);
                        continue;
                    }

                    // 6. 判斷價格詢問
                    if (isPriceInquiry(text)) {
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: '可以參考我們的服務價目表或由客服跟您回覆📋。'
                        });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 可以參考我們的服務價目表或由客服跟您回覆📋。`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 可以參考我們的服務價目表或由客服跟您回覆📋。(User ID: ${userId})`);
                        continue;
                    }

                    // 7. 判斷是否為急件詢問
                    if (isUrgentInquiry(text)) {
                        if (text.includes("3天") || text.includes("三天") || text.includes("3 days") || text.includes("3日")) { // Added English and Japanese
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
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 急件詢問 - 清潔需要一定的工作日。`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 急件詢問 - 清潔需要一定的工作日。(User ID: ${userId})`);
                        continue;
                    }

                    // 8. 判斷是否為清洗時間詢問
                    if (isCleaningTimeInquiry(text)) {
                        const responseText = KEY_VALUE_RESPONSES["清潔時間"][detectedLang] || KEY_VALUE_RESPONSES["清潔時間"]["zh-TW"]; // Fallback to zh-TW
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: responseText
                        });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: ${responseText}`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: ${responseText}(User ID: ${userId})`);
                        continue;
                    }

                    // 9. 關鍵字匹配回應
                    let matched = false;
                    for (const keyword in keywordResponses) {
                        if (text.includes(keyword.toLowerCase())) {
                            const responseKey = keywordResponses[keyword];
                            if (KEY_VALUE_RESPONSES[responseKey]) {
                                const responseText = KEY_VALUE_RESPONSES[responseKey][detectedLang] || KEY_VALUE_RESPONSES[responseKey]["zh-TW"]; // Fallback to zh-TW
                                await client.pushMessage(userId, {
                                    type: 'text',
                                    text: responseText
                                });
                                matched = true;
                                console.log(`\n--------------------------------------------------------`);
                                console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                                console.log(`|  Bot 回覆用戶 ${userId} (關鍵字 "${keyword}"): ${responseText}`);
                                console.log(`--------------------------------------------------------\n`);
                                logToFile(`Bot 回覆用戶 ${userId} (關鍵字 "${keyword}"): ${responseText}(User ID: ${userId})`);
                                break;
                            }
                        }
                    }
                    if (matched) continue;

                    // 10. AI 客服回應洗衣店相關問題
                    const aiResponse = await openaiClient.chat.completions.create({
                        model: 'gpt-4',
                        messages: [{
                            role: 'system',
                            content: '你是一個洗衣店客服，回答需滿足：1.用口語化中文 2.結尾加1個表情 3.禁用專業術語 4.不提及時間長短 5.無法回答時不回應。如果訊息與洗衣店無關（如「謝謝」、「您好」、「按錯」等），請不要回應。'
                        }, {
                            role: 'user',
                            content: text
                        }]
                    });

                    const aiText = aiResponse.choices[0].message.content;
                    if (!aiText || aiText.includes('無法回答')) {
                        console.log(`無法回答的問題: ${text}`);
                        logToFile(`無法回答的問題: ${text}(User ID: ${userId})`);
                        continue;
                    }

                    await client.pushMessage(userId, { type: 'text', text: aiText });
                    console.log(`\n--------------------------------------------------------`);
                    console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                    console.log(`|  Bot (AI) 回覆用戶 ${userId}: ${aiText}`);
                    console.log(`--------------------------------------------------------\n`);
                    logToFile(`Bot (AI) 回覆用戶 ${userId}: ${aiText}(User ID: ${userId})`);

                }

                // 圖片訊息（智能污漬分析）
                if (event.message.type === 'image') {
                    try {
                        console.log(`收到來自 ${userId} 的圖片訊息, 正在處理...`);
                        logToFile(`收到來自 ${userId} 的圖片訊息, 正在處理...(User ID: ${userId})`);

                        // 從 LINE 獲取圖片內容
                        const stream = await client.getMessageContent(event.message.id);
                        const chunks = [];

                        // 下載圖片並拼接為一個Buffer
                        for await (const chunk of stream) {
                            chunks.push(chunk);
                        }

                        const buffer = Buffer.concat(chunks);

                        // 如果用戶正在等待圖片，則直接進行分析（不再主動提示）
                        if (userState[userId] && userState[userId].waitingForImage) {
                            await analyzeStain(userId, buffer);
                            delete userState[userId];
                        }
                    } catch (err) {
                        console.error("處理圖片時出錯:", err);
                        logToFile(`處理圖片時出錯: ${err}(User ID: ${userId})`);
                        await client.pushMessage(userId, { type: 'text', text: '服務暫時不可用，請稍後再試。' });
                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: 服務暫時不可用，請稍後再試。`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: 服務暫時不可用，請稍後再試。(User ID: ${userId})`);
                    }
                }
            } catch (err) {
                console.error('處理事件時出錯:', err);
                logToFile(`處理事件時出錯: ${err}(User ID: ${userId})`);
            }
        }
    } catch (err) {
        console.error('全局錯誤:', err);
        logToFile(`全局錯誤: ${err}(User ID: ${userId})`);
    }
});

// ============== 下載日誌文件 ==============
app.get('/log', (req, res) => {
    res.download(logFilePath, 'logs.txt', (err) => {
        if (err) {
            console.error('下載日誌文件出錯:', err);
            res.status(500).send('下載文件失敗');
        }
    });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行，端口：${PORT}`);
    logToFile(`伺服器正在運行，端口：${PORT}`);
});
