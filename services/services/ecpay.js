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
const ecpay_payment = require('ecpay_aio_node');
require('dotenv').config();

const options = {
  OperationMode: 'Production', // 正式環境
  MercProfile: {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    HashKey: process.env.ECPAY_HASH_KEY,
    HashIV: process.env.ECPAY_HASH_IV,
  },
  IgnorePayment: [],
  IsProjectContractor: false
};

const create = new ecpay_payment(options);

// 建立訂單
function createOrder(orderId, amount) {
  const base_param = {
    MerchantTradeNo: orderId, // 訂單編號 (要唯一)
    MerchantTradeDate: new Date().toLocaleString('zh-TW', { hour12: false }),
    TotalAmount: amount,
    TradeDesc: 'C.H 精緻洗衣付款',
    ItemName: '洗衣服務',
    ReturnURL: 'https://你的伺服器網址/ecpay/return', // 綠界付款完成後會通知
    ClientBackURL: 'https://你的網站網址/thankyou', // 使用者付款完成回到的頁面
  };

  return create.payment_client.aio_check_out_all(base_param);
}

module.exports = { createOrder };

