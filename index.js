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

const COMBINED_INQUIRY_DATA = [
    {
        "zh-TW": {
            keywords: ["價格", "价錢", "收費", "費用", "多少錢", "價位", "算錢", "清洗費", "價目表", "這件多少", "這個價格", "鞋子費用", "洗鞋錢", "要多少", "怎麼算", "窗簾費用"],
            response: "可以參考我們的服務價目表或由客服跟您回覆📋"
        },
        "zh-CN": {
            keywords: ["价格", "价钱", "收费", "费用", "多少钱", "价位", "算钱", "清洗费", "价目表", "这件多少", "这个价格", "鞋子费用", "洗鞋钱", "要多少", "怎么算", "窗帘费用"],
            response: "可以参考我们的服务价目表或由客服跟您回复📋"
        },
        "en": {
            keywords: ["price", "prices", "cost", "how much", "price list", "pricing", "quotation", "quote", "cleaning fee", "how much for", "what's the price"],
            response: "Please refer to our price list or our customer service will reply to you. 📋"
        },
        "ja": {
            keywords: ["価格", "値段", "料金", "費用", "いくら", "料金表", "値段は", "おいくら"],
            response: "料金表をご確認いただくか、カスタマーサービスまでお問い合わせくださいませ📋"
        },
        "ko": {
            keywords: ["가격", "가격표", "요금", "비용", "얼마예요", "얼마", "가격문의"],
            response: "가격표를 참고하시거나 고객센터로 문의해 주십시오📋"
        }
    },
    {
        "zh-TW": {
            keywords: ["營業時間", "營業", "開門時間", "開門", "幾點開門", "營業到幾點", "開到幾點", "今天營業", "今天開門"],
            response: "今日有營業的💖我們的營業時間為 10:30 - 20:00，除週六固定公休喔！😊"
        },
        "zh-CN": {
            keywords: ["营业时间", "营业", "开门时间", "开门", "几点开门", "营业到几点", "开到几点", "今天营业", "今天开门"],
            response: "今日有营业的💖我们的营业时间为 10:30 - 20:00，除周六固定公休喔！😊"
        },
        "en": {
            keywords: ["business hours", "opening hours", "open time", "are you open", "open today", "what time do you open", "營業時間"],
            response: "We are open today! 💖 Our business hours are 10:30 AM - 8:00 PM, except for Saturdays when we are closed. 😊"
        },
        "ja": {
            keywords: ["営業時間", "営業", "開店時間", "開店", "何時開店", "何時まで営業", "今日営業", "今日開店"],
            response: "本日は営業しております💖営業時間は10:30～20:00です。土曜日は定休日です😊"
        },
        "ko": {
            keywords: ["영업시간", "영업", "영업 중", "몇 시 오픈", "오늘 영업", "오늘 하나요", "여는 시간", "문 여는 시간"],
            response: "오늘 영업합니다! 💖 영업 시간은 오전 10시 30분부터 오후 8시까지이며, 토요일은 정기 휴무입니다. 😊"
        }
    },
    {
        "zh-TW": {
            "keywords": ["急件", "加急", "快一點", "趕時間", "來得及嗎", "幾天", "多久", "急單"],
            "response": "不好意思，清潔需要一定的工作日，請與客服確認時間喔 ⏳"
        },
        "zh-CN": {
            "keywords": ["急件", "加急", "快一点", "赶时间", "来得及吗", "几天", "多久", "急单"],
            "response": "不好意思，清洁需要一定的工作日，请与客服确认时间喔 ⏳"
        },
        "en": {
            "keywords": ["urgent", "rush order", "rush service", "how soon", "quickly", "fast", "urgent order"],
            "response": "Sorry, urgent orders may not be possible as cleaning requires processing time. Please check with customer service for availability. ⏳"
        },
        "ja": {
            "keywords": ["急ぎ", "特急", "早めに", "早く", "間に合いますか", "何日", "いつまでに", "急ぎの注文"],
            "response": "申し訳ございません、お急ぎのご依頼ですと対応できない場合がございます。クリーニングには作業日数がかかりますので、カスタマーサービスにご確認ください⏳"
        },
        "ko": {
            "keywords": ["긴급", "급하게", "빨리", "서둘러", "빨리 돼요?", "며칠 걸려요?", "얼마나 걸려요?", "급한 주문"],
            "response": "죄송합니다, 급한 주문은 어려울 수 있습니다. 세탁에는 작업 시간이 필요하므로 고객 센터에 가능 여부를 문의해 주세요 ⏳"
        }
    },
    {
        "zh-TW": {
            "keywords": ["如何付款", "儲值", "付費", "付款", "支付", "給錢", "收款", "收錢", "怎麼付款", "付錢方式", "付款方式", "支付方式"],
            "response": "我們提供現金💵、銀行轉帳🏦、線上Line Pay📱、信用卡💳等多種付款方式。"
        },
        "zh-CN": {
            "keywords": ["如何付款", "储值", "付费", "付款", "支付", "给钱", "收款", "收钱", "怎么付款", "付钱方式", "付款方式", "支付方式"],
            "response": "我们提供现金💵、银行转账🏦、线上Line Pay📱、信用卡💳等多种付款方式。"
        },
        "en": {
            "keywords": ["how to pay", "payment methods", "payment options", "how to make payment", "pay", "fees", "billing", "payment"],
            "response": "We accept various payment methods including cash 💵, bank transfer 🏦, online payment (Line Pay 📱), and credit card 💳."
        },
        "ja": {
            "keywords": ["支払い方法", "支払い", "支払うには", "料金", "支払い方は", "どうやって払う", "支払方法", "決済方法"],
            "response": "現金💵、銀行振込🏦、オンライン決済（Line Pay📱）、クレジットカード💳など、各種お支払い方法をご利用いただけます。"
        },
        "ko": {
            "keywords": ["결제 방법", "결제", "지불", "요금", "어떻게 결제해요?", "결제 수단", "결제 방식", "페이"],
            "response": "현금💵, 계좌 이체🏦, 온라인 결제 (Line Pay📱), 신용 카드💳 등 다양한 결제 수단을 이용하실 수 있습니다."
        }
    },
    {
        "zh-TW": {
            keywords: ["收送", "到府收送", "外送", "收衣服", "送衣服", "來收", "到府", "上門收", "上門", "到府服務"],
            response: "我們有免費到府收送服務📦，可以 LINE 或官網預約喔！🚚 江翠北芳鄰一件就可以免費收送，板橋、新莊、三重、中和、永和滿三件或 500 元，放置管理室跟我們說就可以了！👕"
        },
        "zh-CN": {
            keywords: ["收送", "到府收送", "外送", "收衣服", "送衣服", "来收", "到府", "上门收", "上门", "到府服务"],
            response: "我们有免费到府收送服务📦，可以 LINE 或官网预约喔！🚚 江翠北芳邻一件就可以免费收送，板桥、新庄、三重、中和、永和满三件或 500 元，放置管理室跟我们说就可以了！👕"
        },
        "en": {
            keywords: ["pickup", "delivery", "pick-up", "deliver", "collect", "drop off", "home pickup", "delivery service"],
            response: "We offer free pick-up and delivery service! 📦 You can make a reservation via LINE or our official website! 🚚 Free pick-up and delivery for Jiangcui North Neighborhood for one item, and for Banqiao, Xinzhuang, Sanchong, Zhonghe, and Yonghe, it's free for 3 items or $500. Just leave it at the management office and let us know! 👕"
        },
        "ja": {
            keywords: ["集荷", "配達", "集配", "宅配", "取りに来て", "お届け", "出張集荷", "配送サービス"],
            response: "無料の集荷・配達サービスがございます📦LINEまたは公式サイトからご予約ください！🚚 江翠北芳鄰は1点から無料集配、板橋、新莊、三重、中和、永和は3点または500元以上で無料です。管理人室に置いていただければ結構です！👕"
        },
        "ko": {
            keywords: ["수거", "배달", "픽업", "방문 수거", "배송", "수거 돼요?", "배달 돼요?", "집으로 와주세요", "수거 서비스", "배달 서비스"],
            response: "무료 방문 수거 및 배달 서비스를 제공합니다! 📦 LINE 또는 공식 웹사이트를 통해 예약하실 수 있습니다! 🚚 쟝추이베이린(江翠北芳鄰)은 1개 품목부터 무료 수거 및 배달이 가능하며, 반차오(板橋), 신좡(新莊), 싼총(三重), 중허(中和), 융허(永和) 지역은 3개 품목 이상 또는 500달러 이상이면 무료입니다. 관리실에 맡기시고 저희에게 알려주시면 됩니다! 👕"
        }
    },
    {
        "zh-TW": {
            keywords: ["清洗服務", "清潔服務", "洗衣服務", "洗什麼", "可以洗什麼", "服務項目", "清洗項目", "清潔項目", "洗衣項目", "地毯", "有洗地毯", "有清洗地毯", "窗簾", "有洗窗簾", "有清洗窗簾"],
            response: "我們提供各式衣物、包包、地毯等清洗服務，您可以告訴我們具體需求，我們會根據狀況安排清洗。🧹"
        },
        "zh-CN": {
            keywords: ["清洗服务", "清洁服务", "洗衣服务", "洗什么", "可以洗什么", "服务项目", "清洗项目", "清洁项目", "洗衣项目", "地毯", "有洗地毯", "有清洗地毯", "窗帘", "有洗窗帘", "有清洗窗帘"],
            response: "我们提供各式衣物、包包、地毯等清洗服务，您可以告诉我们具体需求，我们会根据状况安排清洗。🧹"
        },
        "en": {
            keywords: ["cleaning service", "laundry service", "wash service", "what do you wash", "services", "cleaning items", "laundry items", "carpet", "carpet cleaning", "curtain", "curtain cleaning"],
            response: "We provide cleaning services for various items such as clothes, bags, carpets, etc. Please let us know your specific needs, and we will arrange cleaning based on the situation. 🧹"
        },
        "ja": {
            keywords: ["クリーニングサービス", "洗濯サービス", "洗濯", "何を洗える", "サービス内容", "クリーニング品目", "洗濯品目", "カーペット", "カーペットクリーニング", "カーテン", "カーテンクリーニング"],
            response: "衣類、バッグ、カーペットなど、様々なクリーニングサービスを提供しております。具体的なご要望をお知らせいただければ、状況に応じてクリーニングを手配いたします。🧹"
        },
        "ko": {
            keywords: ["세탁 서비스", "클리닝 서비스", "뭐 세탁", "무슨 세탁", "세탁 종류", "세탁 품목", "세탁 서비스 종류", "클리닝 품목", "카펫", "카펫 세탁", "커튼", "커튼 세탁"],
            response: "저희는 의류, 가방, 카펫 등 다양한 품목에 대한 세탁 서비스를 제공합니다. 구체적인 요구 사항을 알려주시면 상황에 따라 세탁을 준비해 드리겠습니다. 🧹"
        }
    },
    {
        "zh-TW": {
            keywords: ["清潔時間", "拿到", "洗要多久", "多久", "會好", "送洗時間", "清洗要多久", "洗多久", "何時好", "何時可以拿", "多久洗好"],
            response: "我們的清潔時間一般約 7-10 個工作天⏰，完成後會自動通知您喔！謝謝您⏳"
        },
        "zh-CN": {
            keywords: ["清洁时间", "拿到", "洗要多久", "多久", "会好", "送洗时间", "清洗要多久", "洗多久", "何时好", "何时可以拿", "多久洗好"],
            response: "我们的清洁时间一般约 7-10 个工作天⏰，完成后会自动通知您喔！谢谢您⏳"
        },
        "en": {
            keywords: ["cleaning time", "get back", "how long to clean", "how long", "when will be ready", "delivery time", "how long does it take", "when can I get it", "turnaround time"],
            response: "Our cleaning time is generally about 7-10 business days ⏰. We will automatically notify you when it's done! Thank you ⏳"
        },
        "ja": {
            keywords: ["クリーニング時間", "受け取り", "洗濯時間", "どのくらい", "いつできる", "配達時間", "何日かかる", "いつ受け取れる", "仕上がり時間"],
            response: "クリーニング時間は通常7～10営業日です⏰完了したら自動的にお知らせします。ありがとうございます⏳"
        },
        "ko": {
            keywords: ["세탁 시간", "찾으러", "얼마나 걸려", "세탁 얼마나 걸려요", "언제 돼", "언제 찾을 수 있어", "걸리는 시간", "세탁 완료 시간", "찾아갈 시간"],
            response: "세탁 시간은 일반적으로 7-10 영업일 정도 소요됩니다 ⏰. 완료되면 자동으로 알려드립니다! 감사합니다 ⏳"
        }
    },
    {
        "zh-TW": {
            keywords: ["洗好", "洗好了嗎", "進度", "好了嗎", "完成了嗎", "洗到哪", "洗到哪了", "進度查詢", "查詢進度", "洗完沒", "洗好了没"],
            response: "營業時間會馬上查詢您的清洗進度😊，並回覆您！謝謝您🔍"
        },
        "zh-CN": {
            keywords: ["洗好", "洗好了吗", "进度", "好了吗", "完成了吗", "洗到哪", "洗到哪了", "进度查询", "查询进度", "洗完没", "洗好了没"],
            response: "营业时间会马上查询您的清洗进度😊，并回复您！谢谢您🔍"
        },
        "en": {
            keywords: ["done", "ready", "progress", "is it done", "is it ready", "status", "check progress", "how's the progress", "where is my laundry", "finished yet"],
            response: "During business hours, we will immediately check your cleaning progress 😊 and reply to you! Thank you 🔍"
        },
        "ja": {
            keywords: ["洗い上がり", "終わった", "進捗", "終わりましたか", "完了しましたか", "ステータス", "進捗確認", "どうなってる", "仕上がり", "洗濯物どこ"],
            response: "営業時間内にクリーニングの進捗状況を確認し、すぐにご返信いたします😊ありがとうございます🔍"
        },
        "ko": {
            keywords: ["다 됐어?", "다 됐나요", "진행 상황", "진행", "됐나", "어디까지 됐어", "어디까지 진행됐어", "진행 확인", "세탁물 확인", "끝났어?", "세탁 끝났나요"],
            response: "영업시간 중에는 즉시 세탁 진행 상황을 확인하고 😊 답변드리겠습니다! 감사합니다 🔍"
        }
    },
    {
        "zh-TW": {
            keywords: ["油漬", "油污", "油垢", "油斑", "油漬處理", "油污處理"],
            response: "油漬我們有專門的處理方式，大部分都可以變淡，請放心！🍳"
        },
        "zh-CN": {
            keywords: ["油渍", "油污", "油垢", "油斑", "油渍处理", "油污处理"],
            response: "油渍我们有专门的处理方式，大部分都可以变淡，请放心！🍳"
        },
        "en": {
            keywords: ["oil stain", "grease stain", "oil mark", "grease mark", "oil stain treatment", "grease stain treatment"],
            response: "We have special treatments for oil stains, most of them can be lightened, please rest assured! 🍳"
        },
        "ja": {
            keywords: ["油汚れ", "油染み", "油", "油汚れ処理", "油染み処理"],
            response: "油汚れには専門の処理方法があり、ほとんどの場合は薄くすることができますのでご安心ください！🍳"
        },
        "ko": {
            keywords: ["기름 얼룩", "기름때", "기름", "기름 얼룩 제거", "기름때 제거", "기름 지워지나요"],
            response: "기름 얼룩은 전문적인 처리 방법이 있으며, 대부분 옅어질 수 있으니 안심하세요! 🍳"
        }
    },
    {
        "zh-TW": {
            keywords: ["血漬", "血跡", "血污", "血斑", "血漬處理", "血跡處理"],
            response: "血漬我們會盡力處理，但成功率視沾染時間和材質而定喔！💉"
        },
        "zh-CN": {
            keywords: ["血渍", "血迹", "血污", "血斑", "血渍处理", "血迹处理"],
            response: "血渍我们会尽力处理，但成功率视沾染时间和材质而定喔！💉"
        },
        "en": {
            keywords: ["blood stain", "blood mark", "blood spot", "blood stain treatment", "blood mark treatment"],
            response: "We will try our best to deal with blood stains, but the success rate depends on the staining time and material! 💉"
        },
        "ja": {
            keywords: ["血", "血痕", "血染み", "血汚れ", "血染み処理", "血汚れ処理"],
            response: "血液のシミはできる限り対応しますが、成功率は付着時間と素材によって異なります！💉"
        },
        "ko": {
            keywords: ["피 얼룩", "혈흔", "피", "피 얼룩 제거", "피 지워지나요", "피 빼주세요"],
            response: "피 얼룩은 최선을 다해 처리해 드리겠지만, 성공률은 얼룩진 시간과 재질에 따라 달라집니다! 💉"
        }
    },
    {
        "zh-TW": {
            keywords: ["醬油", "醬油漬", "醬油污漬", "醬油斑", "醬油漬處理", "醬油污漬處理"],
            response: "醬油污漬我們有專門的處理方式，大部分都可以變淡，請放心！🍶"
        },
        "zh-CN": {
            keywords: ["酱油", "酱油渍", "酱油污渍", "酱油斑", "酱油渍处理", "酱油污渍处理"],
            response: "酱油污渍我们有专门的处理方式，大部分都可以变淡，请放心！🍶"
        },
        "en": {
            keywords: ["soy sauce stain", "soy sauce mark", "soy sauce spot", "soy sauce stain treatment", "soy sauce mark treatment"],
            response: "We have special treatments for soy sauce stains, most of them can be lightened, please rest assured! 🍶"
        },
        "ja": {
            keywords: ["醤油", "醤油染み", "醤油汚れ", "醤油染み処理", "醤油汚れ処理"],
            response: "醤油のシミには専門の処理方法があり、ほとんどの場合は薄くすることができますのでご安心ください！🍶"
        },
        "ko": {
            keywords: ["간장", "간장 얼룩", "간장 자국", "간장 얼룩 제거", "간장 지워지나요", "간장 빼주세요"],
            response: "간장 얼룩은 전문적인 처리 방법이 있으며, 대부분 옅어질 수 있으니 안심하세요! 🍶"
        }
    },
    {
        "zh-TW": {
            keywords: ["污漬", "髒污", "污垢", "汙漬", "髒汙", "汙垢", "污漬處理", "髒污處理", "汙漬處理", "ทั่วไป stain", "洗的掉"],
            response: "我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨"
        },
        "zh-CN": {
            keywords: ["污渍", "脏污", "污垢", "汙渍", "脏汙", "汙垢", "污渍处理", "脏污处理", "汙渍处理", "ทั่วไป stain", "洗的掉"],
            response: "我们会针对污渍做专门处理，大部分污渍都可以变淡，但成功率视污渍种类与衣物材质而定喔！✨"
        },
        "en": {
            keywords: ["stain", "dirt", "mark", "spot", "stain treatment", "dirt treatment", "mark treatment", "can be washed off", "washable stain"],
            response: "We will treat stains specifically, most stains can be lightened, but the success rate depends on the type of stain and the material of the clothing! ✨"
        },
        "ja": {
            keywords: ["シミ", "汚れ", "染み", "シミ処理", "汚れ処理", "染み処理", "一般的なシミ", "洗い落とせる"],
            response: "シミの種類に応じて専門的な処理を行い、ほとんどのシミは薄くすることができますが、成功率はシミの種類や衣類の素材によって異なります！✨"
        },
        "ko": {
            keywords: ["얼룩", "오염", "때", "자국", "얼룩 제거", "오염 제거", "자국 제거", "일반 얼룩", "씻어낼 수 있나요", "지워지는 얼룩"],
            response: "얼룩에 대해 전문적으로 처리해 드리며, 대부분의 얼룩은 옅어질 수 있지만 성공률은 얼룩 종류와 의류 재질에 따라 달라집니다! ✨"
        }
    },
    {
        "zh-TW": {
            keywords: ["盡力", "盡量", "盡可能", "盡力處理", "盡量處理", "盡可能處理", "努力處理污漬", "洗掉"],
            response: "我們會盡力處理污漬，但滲透到纖維或時間較久的污漬可能無法完全去除，請見諒！😊"
        },
        "zh-CN": {
            keywords: ["尽力", "尽量", "尽可能", "尽力处理", "尽量处理", "尽可能处理", "努力处理污渍", "洗掉"],
            response: "我们会尽力处理污渍，但渗透到纤维或时间较久的污渍可能无法完全去除，请见谅！😊"
        },
        "en": {
            keywords: ["best effort", "try best", "do my best", "try hard", "best effort for stain", "try best to remove stain", "wash off"],
            response: "We will do our best to treat stains, but stains that have penetrated into the fibers or are old may not be completely removed, please understand! 😊"
        },
        "ja": {
            keywords: ["尽力", "できる限り", "最大限", "尽力して処理", "できる限り処理", "最大限に処理", "シミを頑張って取る", "洗い落とす"],
            response: "シミの処理には最善を尽くしますが、繊維に浸透したシミや時間の経過したシミは完全に除去できない場合があります。ご了承ください！😊"
        },
        "ko": {
            keywords: ["최대한", "최대한 노력", "최선을 다해", "최대한 처리", "노력", "최대한 얼룩 제거", "힘써서 얼룩 제거", "씻어내다"],
            response: "얼룩을 최대한 처리해 드리겠지만, 섬유에 침투했거나 오래된 얼룩은 완전히 제거되지 않을 수 있습니다. 양해 부탁드립니다! 😊"
        }
    },
    {
        "zh-TW": {
            keywords: ["染色", "染到色", "被染色", "染色問題", "染色處理", "處理染色", "染色怎麼辦"],
            response: "染色問題我們會盡量處理，但如果滲透到衣物纖維或面積較大，不能保證完全處理喔！🌈"
        },
        "zh-CN": {
            keywords: ["染色", "染到色", "被染色", "染色问题", "染色处理", "处理染色", "染色怎么办"],
            response: "染色问题我们会尽量处理，但如果渗透到衣物纤维或面积较大，不能保证完全处理喔！🌈"
        },
        "en": {
            keywords: ["dyeing", "dye transfer", "color bleed", "dyeing issue", "dyeing problem", "dyeing treatment", "color bleed treatment"],
            response: "We will try our best to deal with dyeing issues, but if it has penetrated into the clothing fibers or the area is large, complete removal cannot be guaranteed! 🌈"
        },
        "ja": {
            keywords: ["染色", "色移り", "染まってしまった", "染色問題", "染色処理", "色移り処理", "染色どうすれば"],
            response: "染色の問題にはできる限り対応しますが、衣類の繊維に浸透していたり、面積が大きい場合は、完全に除去できるとは限りません！🌈"
        },
        "ko": {
            keywords: ["염색", "이염", "물들었어", "염색 문제", "염색 처리", "이염 처리", "염색 됐는데", "염색 어떡해"],
            response: "염색 문제는 최대한 처리해 드리겠지만, 의류 섬유에 침투했거나 면적이 넓은 경우에는 완전한 처리를 보장할 수 없습니다! 🌈"
        }
    },
    {
        "zh-TW": {
            keywords: ["退色", "褪色", "掉色", "退色問題", "褪色問題", "掉色問題", "退色怎麼辦", "褪色怎麼辦", "掉色怎麼辦"],
            response: "已經退色的衣物是無法恢復的，請見諒！🎨"
        },
        "zh-CN": {
            keywords: ["退色", "褪色", "掉色", "退色问题", "褪色问题", "掉色问题", "退色怎么办", "褪色怎么办", "掉色怎么办"],
            response: "已经退色的衣物是无法恢复的，请见谅！🎨"
        },
        "en": {
            keywords: ["fading", "color fade", "fade color", "fading issue", "fading problem", "color fading issue", "color fade problem"],
            response: "Clothes that have already faded cannot be restored, please understand! 🎨"
        },
        "ja": {
            keywords: ["退色", "色あせ", "色落ち", "退色問題", "色あせ問題", "色落ち問題", "退色どうすれば", "色あせどうすれば", "色落ちどうすれば"],
            response: "すでに色あせた衣類は元に戻せません。ご了承ください！🎨"
        },
        "ko": {
            keywords: ["탈색", "색 바램", "색 빠짐", "탈색 문제", "색 바램 문제", "색 빠짐 문제", "탈색 됐어", "색 바랬어", "색 빠졌어", "탈색 어떡해", "색 바램 어떡해", "색 빠짐 어떡해"],
            response: "이미 탈색된 의류는 복원할 수 없습니다. 양해 부탁드립니다! 🎨"
        }
    },
    {
        "zh-TW": {
            keywords: ["衣物清洗", "衣服清洗", "外套清洗", "襯衫清洗", "褲子清洗", "裙子清洗", "可以洗衣服嗎", "什麼衣服可以洗", "各種衣物清洗", "是否能清洗衣物"],
            response: "我們提供各式衣物清洗服務，無論是衣服、外套、襯衫等都可以清洗。👕"
        },
        "zh-CN": {
            keywords: ["衣物清洗", "衣服清洗", "外套清洗", "衬衫清洗", "裤子清洗", "裙子清洗", "可以洗衣服吗", "什么衣服可以洗", "各种衣物清洗", "是否能清洗衣物"],
            response: "我们提供各式衣物清洗服务，无论是衣服、外套、衬衫等都可以清洗。👕"
        },
        "en": {
            keywords: ["clothing cleaning", "clothes cleaning", "coat cleaning", "shirt cleaning", "pants cleaning", "skirt cleaning", "can wash clothes", "what clothes can be washed", "various clothing cleaning", "can you wash clothes"],
            response: "We provide various clothing cleaning services, including clothes, coats, shirts, etc. 👕"
        },
        "ja": {
            keywords: ["衣類クリーニング", "服クリーニング", "コートクリーニング", "シャツクリーニング", "ズボンクリーニング", "スカートクリーニング", "服洗えますか", "どんな服洗える", "様々な衣類クリーニング", "服は洗えますか"],
            response: "衣類、コート、シャツなど、様々な衣類のクリーニングサービスを提供しております。👕"
        },
        "ko": {
            keywords: ["의류 세탁", "옷 세탁", "코트 세탁", "셔츠 세탁", "바지 세탁", "치마 세탁", "옷 세탁 되나요", "무슨 옷 세탁", "옷 종류 세탁", "다양한 의류 세탁", "옷 세탁 가능"],
            response: "저희는 옷, 코트, 셔츠 등 다양한 의류 세탁 서비스를 제공합니다. 👕"
        }
    },
    {
        "zh-TW": {
            keywords: ["寶寶汽座", "汽座"],
            response: "我們有清洗寶寶汽座，費用是 $900 👶"
        },
        "zh-CN": {
            keywords: ["宝宝汽座", "汽座"],
            response: "我们有清洗宝宝汽座，费用是 $900 👶"
        },
        "en": {
            keywords: ["baby car seat", "car seat"],
            response: "We clean baby car seats, the fee is $900 👶"
        },
        "ja": {
            keywords: ["ベビーシート", "チャイルドシート", "カーシート"],
            response: "ベビーシートのクリーニングを承っております。料金は900ドルです👶"
        },
        "ko": {
            keywords: ["아기 카시트", "카시트"],
            response: "아기 카시트 세척해 드립니다. 비용은 900달러입니다 👶"
        }
    },
    {
        "zh-TW": {
            keywords: ["手推車"],
            response: "我們有清洗手推車，寶寶單人手推車費用是 $1200 🛒，雙人手推車費用是 $1800 🛒"
        },
        "zh-CN": {
            keywords: ["手推车"],
            response: "我们有清洗手推车，宝宝单人手推车费用是 $1200 🛒，双人手推车费用是 $1800 🛒"
        },
        "en": {
            keywords: ["stroller", "baby stroller", "pram"],
            response: "We clean strollers. Single baby stroller cleaning fee is $1200 🛒, double stroller is $1800 🛒"
        },
        "ja": {
            keywords: ["ベビーカー", "乳母車"],
            response: "ベビーカーのクリーニングを承っております。シングルベビーカーは1200ドル🛒、二人乗りベビーカーは1800ドル🛒です。"
        },
        "ko": {
            keywords: ["유모차"],
            response: "유모차 세척해 드립니다. 싱글 유모차 세척 비용은 1200달러 🛒, 쌍둥이 유모차는 1800달러 🛒입니다."
        }
    },
    {
        "zh-TW": {
            keywords: ["書包"],
            response: "我們有清洗書包，費用是 $550 🎒"
        },
        "zh-CN": {
            keywords: ["书包"],
            response: "我们有清洗书包，费用是 $550 🎒"
        },
        "en": {
            keywords: ["backpack", "school bag"],
            response: "We clean backpacks, the fee is $550 🎒"
        },
        "ja": {
            keywords: ["リュックサック", "ランドセル", "スクールバッグ"],
            response: "リュックサックのクリーニングを承っております。料金は550ドルです🎒"
        },
        "ko": {
            keywords: ["책가방", "배낭"],
            response: "책가방 세척해 드립니다. 비용은 550달러입니다 🎒"
        }
    },
    {
        "zh-TW": {
            keywords: ["洗的掉"],
            response: "我們會針對污漬做專門處理，大部分污漬都可以變淡，但成功率視污漬種類與衣物材質而定喔！✨"
        },
        "zh-CN": {
            keywords: ["洗的掉"],
            response: "我们会针对污渍做专门处理，大部分污渍都可以变淡，但成功率视污渍种类与衣物材质而定喔！✨"
        },
        "en": {
            keywords: ["washable"],
            response: "We will treat stains specifically, most stains can be lightened, but the success rate depends on the type of stain and the material of the clothing! ✨"
        },
        "ja": {
            keywords: ["洗える", "落ちる"],
            response: "シミの種類に応じて専門的な処理を行い、ほとんどのシミは薄くすることができますが、成功率はシミの種類や衣類の素材によって異なります！✨"
        },
        "ko": {
            keywords: ["지워져요", "세탁 돼요"],
            response: "얼룩에 대해 전문적으로 처리해 드리며, 대부분의 얼룩은 옅어질 수 있지만 성공률은 얼룩 종류와 의류 재질에 따라 달라집니다! ✨"
        }
    },
    {
        "zh-TW": {
            keywords: ["洗掉"],
            response: "我們會盡力處理污漬，但滲透到纖維或時間較久的污漬可能無法完全去除，請見諒！😊"
        },
        "zh-CN": {
            keywords: ["洗掉"],
            response: "我们会尽力处理污渍，但渗透到纤维或时间较久的污渍可能无法完全去除，请见谅！😊"
        },
        "en": {
            keywords: ["remove stain"],
            response: "We will do our best to treat stains, but stains that have penetrated into the fibers or are old may not be completely removed, please understand! 😊"
        },
        "ja": {
            keywords: ["落とす", "除去"],
            response: "シミの処理には最善を尽くしますが、繊維に浸透したシミや時間の経過したシミは完全に除去できない場合があります。ご了承ください！😊"
        },
        "ko": {
            keywords: ["지워주세요", "빼주세요"],
            response: "얼룩을 최대한 처리해 드리겠지만, 섬유에 침투했거나 오래된 얼룩은 완전히 제거되지 않을 수 있습니다. 양해 부탁드립니다! 😊"
        }
    },
    {
        "zh-TW": {
            keywords: ["染色"],
            response: "染色問題我們會盡量處理，但如果滲透到衣物纖維或面積較大，不能保證完全處理喔！🌈"
        },
        "zh-CN": {
            keywords: ["染色"],
            response: "染色问题我们会尽量处理，但如果渗透到衣物纤维或面积较大，不能保证完全处理喔！🌈"
        },
        "en": {
            keywords: ["dyeing"],
            response: "We will try our best to deal with dyeing issues, but if it has penetrated into the clothing fibers or the area is large, complete removal cannot be guaranteed! 🌈"
        },
        "ja": {
            keywords: ["染色"],
            response: "染色の問題にはできる限り対応しますが、衣類の繊維に浸透していたり、面積が大きい場合は、完全に除去できるとは限りません！🌈"
        },
        "ko": {
            keywords: ["염색"],
            response: "염색 문제는 최대한 처리해 드리겠지만, 의류 섬유에 침투했거나 면적이 넓은 경우에는 완전한 처리를 보장할 수 없습니다! 🌈"
        }
    },
    {
        "zh-TW": {
            keywords: ["退色"],
            response: "已經退色的衣物是無法恢復的，請見諒！🎨"
        },
        "zh-CN": {
            keywords: ["退色"],
            response: "已经退色的衣物是无法恢复的，请见谅！🎨"
        },
        "en": {
            keywords: ["fading"],
            response: "Clothes that have already faded cannot be restored, please understand! 🎨"
        },
        "ja": {
            keywords: ["退色"],
            response: "すでに色あせた衣類は元に戻せません。ご了承ください！🎨"
        },
        "ko": {
            keywords: ["탈색"],
            response: "이미 탈색된 의류는 복원할 수 없습니다. 양해 부탁드립니다! 🎨"
        }
    },
    {
        "zh-TW": {
            keywords: ["地毯", "有洗地毯", "有清洗地毯"],
            response: "我們提供地毯清洗服務，請告知我們您需要清洗的地毯狀況，我們會跟您回覆清洗價格。🧹"
        },
        "zh-CN": {
            keywords: ["地毯", "有洗地毯", "有清洗地毯"],
            response: "我们提供地毯清洗服务，请告知我们您需要清洗的地毯状况，我们会跟您回复清洗价格。🧹"
        },
        "en": {
            keywords: ["carpet", "carpet cleaning"],
            response: "We provide carpet cleaning services. Please tell us the condition of the carpet you need to clean, and we will reply with the cleaning price. 🧹"
        },
        "ja": {
            keywords: ["カーペット", "カーペットクリーニング"],
            response: "カーペットクリーニングサービスを提供しております。クリーニングが必要なカーペットの状態をお知らせいただければ、クリーニング料金をお知らせいたします。🧹"
        },
        "ko": {
            keywords: ["카펫", "카펫 세탁"],
            response: "카펫 세탁 서비스를 제공합니다. 세탁이 필요한 카펫 상태를 알려주시면 세탁 가격을 알려드리겠습니다. 🧹"
        }
    },
    {
        "zh-TW": {
            keywords: ["窗簾", "有洗窗簾", "有清洗窗簾"],
            response: "我們提供窗簾清洗服務，請提供您的窗簾尺寸和材質，我們會跟您回覆清洗價格。🪟"
        },
        "zh-CN": {
            keywords: ["窗帘", "有洗窗帘", "有清洗窗帘"],
            response: "我们提供窗帘清洗服务，请提供您的窗帘尺寸和材质，我们会跟您回复清洗价格。🪟"
        },
        "en": {
            keywords: ["curtain", "curtain cleaning"],
            response: "We provide curtain cleaning services. Please provide your curtain size and material, and we will reply with the cleaning price. 🪟"
        },
        "ja": {
            keywords: ["カーテン", "カーテンクリーニング"],
            response: "カーテンクリーニングサービスを提供しております。カーテンのサイズと素材をお知らせいただければ、クリーニング料金をお知らせいたします。🪟"
        },
        "ko": {
            keywords: ["커튼", "커튼 세탁"],
            response: "커튼 세탁 서비스를 제공합니다. 커튼 사이즈와 재질을 알려주시면 세탁 가격을 알려드리겠습니다. 🪟"
        }
    },
    {
        "zh-TW": {
            keywords: ["是否能清洗衣物"],
            response: "我們提供各式衣物清洗服務，無論是衣服、外套、襯衫等都可以清洗。👕"
        },
        "zh-CN": {
            keywords: ["是否能清洗衣物"],
            response: "我们提供各式衣物清洗服务，无论是衣服、外套、衬衫等都可以清洗。👕"
        },
        "en": {
            keywords: ["can you wash clothes"],
            response: "We provide various clothing cleaning services, including clothes, coats, shirts, etc. 👕"
        },
        "ja": {
            keywords: ["服は洗えますか"],
            response: "衣類、コート、シャツなど、様々な衣類のクリーニングサービスを提供しております。👕"
        },
        "ko": {
            keywords: ["옷 세탁 가능"],
            response: "저희는 옷, 코트, 셔츠 등 다양한 의류 세탁 서비스를 제공합니다. 👕"
        }
    },
    {
        "zh-TW": {
            "keywords": ["收回了嗎", "來收了嗎", "收走了嗎", "收走", "拿了嗎", "收了嗎", "收件了嗎", "拿走"],
            "response": "今日會收回，收回也會跟您通知的🚚。"
        },
        "zh-CN": {
            "keywords": ["收回了吗", "来收了吗", "收走了吗", "收走", "拿了吗", "收了吗", "收件了吗", "拿走"],
            "response": "今日会收回，收回也会跟您通知的🚚。"
        },
        "en": {
            "keywords": ["picked up?", "has it been picked up?", "was it picked up?", "will it be picked up?", "is it picked up?", "collection", "collected"],
            "response": "It will be picked up today, and we will notify you when it's collected. 🚚"
        },
        "ja": {
            "keywords": ["回収されましたか", "集荷されましたか", "回収済みですか", "集荷済みですか", "回収は", "集荷は"],
            "response": "本日回収いたします。回収次第ご連絡いたします🚚"
        },
        "ko": {
            "keywords": ["수거 됐나요", "수거 완료 됐나요", "회수 됐나요", "회수 완료 됐나요", "수거", "회수"],
            "response": "오늘 수거 예정입니다. 수거 완료되면 알려드릴게요🚚"
        }
    }
];

function detectInquiryType(text) {
    const lowerText = text.toLowerCase();

    for (const inquiry of COMBINED_INQUIRY_DATA) {
        for (const lang in inquiry) {
            if (inquiry[lang].keywords) { // Check that keywords array exists.
                for (const keyword of inquiry[lang].keywords) {
                    const lowerKeyword = keyword.toLowerCase();

                    if (lowerText.includes(lowerKeyword)) {
                        return inquiry[lang].response;
                    }
                }
            }
        }
    }

    return null; // No match found
}

// ============== 判斷是否與洗衣店相關 (使用關鍵字列表) ============== // Keep this function, used before calling AI
function isLaundryRelatedText(text) {
    const lowerText = text.toLowerCase();
    const keywords = [
        { lang: "zh-TW", keywords: ["洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾", "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", "書包", "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約"] },
        { lang: "zh-CN", keywords: ["洗衣", "清洗", "污渍", "油渍", "血渍", "酱油", "染色", "退色", "地毯", "窗帘", "宝宝汽座", "汽座", "儿童座椅", "安全儿童座椅", "手推车", "单人手推车", "宝宝手推车", "书包", "营业", "开门", "休息", "开店", "有开", "收送", "到府", "上门", "收衣", "预约"] },
        { lang: "en", keywords: ["laundry", "clean", "stain", "oil stain", "blood stain", "soy sauce", "dyeing", "fading", "carpet", "curtain", "baby car seat", "car seat", "child seat", "stroller", "baby stroller", "backpack", "open", "business hours", "pickup", "delivery", "collect clothes", "reservation"] },
        { lang: "ja", keywords: ["洗濯", "クリーニング", "汚れ", "油汚れ", "血", "醤油", "染色", "色落ち", "カーペット", "カーテン", "ベビーシート", "チャイルドシート", "ベビーカー", "ランドセル", "営業", "開店", "休憩", "オープン", "集荷", "配達", "予約"] },
    ]

    return keywords.some(inquiry => inquiry.keywords.some(keyword => lowerText.includes(keyword.toLowerCase())));
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

                    // 檢查是否包含強制不回應的關鍵字
                    const shouldIgnore = ignoredKeywords.some(keyword => text.includes(keyword.toLowerCase()));
                    if (shouldIgnore) {
                        console.log(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。`);
                        logToFile(`用戶 ${userId} 的訊息與洗衣店無關，已忽略。(User ID: ${userId})`);
                        continue;
                    }

                    // 1. 按「1」啟動智能污漬分析
                    if (text === '1') {
                        const usage = await checkUsage(userId);
                        if (!usage) {
                            await client.pushMessage(userId, {
                                type: 'text',
                                text: '您已達到每週2次的使用上限，請下週再試。'
                            })
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
                                        uri: "https://liff.line.me/2004612704-JnzA1qN6"
                                    }
                                }]
                            }
                        });

                        continue;
                    }

                    // 2. 檢測詢問類型和語言
                    const inquiryResult = detectInquiryType(text);

                    if (inquiryResult) {
                        await client.pushMessage(userId, {
                            type: 'text',
                            text: inquiryResult
                        });

                        console.log(`\n--------------------------------------------------------`);
                        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
                        console.log(`|  Bot 回覆用戶 ${userId}: ${inquiryResult}`);
                        console.log(`--------------------------------------------------------\n`);
                        logToFile(`Bot 回覆用戶 ${userId}: ${inquiryResult}(User ID: ${userId})`);
                        continue;
                    }

                    // 3. AI 客服回應洗衣店相關問題 (如果沒有匹配到預設的詢問類型)
                    if (isLaundryRelatedText(text)) { // 仍然需要判斷是否與洗衣相關，再调用AI
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
                    } else {
                        console.log(`用戶 ${userId} 的訊息與洗衣店無關，不使用AI回應。`);
                        logToFile(`用戶 ${userId} 的訊息與洗衣店無關，不使用AI回應。(User ID: ${userId})`);
                    }


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