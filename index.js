// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const keywordRules = require('./keywordRules');
const AddressDetector = require('./addressDetector');
const { handleDynamicReceiving } = require('./dynamicReply');
const SheetsReply = require('./sheetsReply');
const crypto = require('crypto');

const app = express();

// ✅ 配置验证
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

console.log('\n=== 环境变量验证 ===');
console.log('Channel Secret:', config.channelSecret ? '✅ 已配置' : '❌ 未配置');
console.log('Channel Access Token:', config.channelAccessToken ? '✅ 已配置' : '❌ 未配置');

const client = new line.Client(config);
const sheetsReply = new SheetsReply();

// ✅ Google Sheets 初始化
(async () => {
  try {
    await sheetsReply.loadData();
    console.log('✅ Google Sheets数据加载成功');
    
    setInterval(async () => {
      try {
        await sheetsReply.loadData();
        console.log('🔄 Google Sheets数据已更新');
      } catch (error) {
        console.error('❌ Google Sheets更新失败:', error);
      }
    }, 30 * 60 * 1000);
  } catch (error) {
    console.error('❌ Google Sheets初始化失败:', error);
  }
})();

// ✅ 核心消息处理逻辑
async function handleMessage(event) {
  try {
    console.log('\n=== 消息处理开始 ===');
    const text = event.message.text;
    console.log('用户ID:', event.source.userId);
    console.log('消息内容:', text);

    let replyMessage = null;

    // 🔄 处理流程优化
    const processSteps = [
      { name: '地址检测', handler: () => AddressDetector.isAddress(event.source.userId) && /(送回|送還|拿回來)/.test(text) },
      { name: 'Sheets回复', handler: () => sheetsReply.getReply(text) },
      { name: '动态收送', handler: () => /(收件|取件|來拿|預約)/.test(text) && handleDynamicReceiving(text) },
      { name: '关键字规则', handler: () => keywordRules.find(rule => rule.keywords.some(kw => text.includes(kw)))?.response },
      { name: '通用回复', handler: () => isLaundryRelated(text) ? '您可以參考常見問題或按『3』😊，客服會盡快回覆您！' : null }
    ];

    for (const step of processSteps) {
      const result = step.handler();
      if (result) {
        console.log(`✔️ 触发 ${step.name}`);
        replyMessage = typeof result === 'function' ? result(text) : result;
        break;
      }
    }

    if (replyMessage) {
      console.log('💬 发送回复:', replyMessage);
      await client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
    } else {
      console.log('⏩ 无匹配规则，跳过回复');
    }

  } catch (error) {
    console.error('\n⚠️ 处理异常:', error);
    if (error instanceof line.HTTPError) {
      console.error('LINE API错误详情:', error.statusCode, error.body);
    }
  }
}

// ✅ 强化签名验证中间件
app.post('/webhook', (req, res, next) => {
  try {
    const signature = req.headers['x-line-signature'];
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', config.channelSecret).update(body).digest('base64');

    console.log('\n🔒 签名验证:');
    console.log('预期签名:', hash);
    console.log('收到签名:', signature);

    if (hash !== signature) {
      throw new Error('签名验证失败');
    }
    next();
  } catch (error) {
    console.error('❌ 安全验证失败:', error.message);
    res.status(403).json({ error: error.message });
  }
}, async (req, res) => {
  try {
    const events = req.body.events.filter(e => e.type === 'message' && e.message.type === 'text');
    
    // 先响应LINE服务器
    res.status(200).end();
    
    // 异步处理消息
    await Promise.all(events.map(handleMessage));
    
  } catch (error) {
    console.error('❌ 消息处理失败:', error);
  }
});

// ✅ 实用函数
function isLaundryRelated(text) {
  const keywords = [
    '洗衣', '清洗', '污漬', '油漬', '血漬', '染色', '退色', '地毯', 
    '窗簾', '汽座', '手推車', '營業', '收送', '價目', '費用'
  ];
  return keywords.some(kw => text.toLowerCase().includes(kw));
}

// ✅ 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 服务已启动 http://localhost:${PORT}`);
  console.log('📡 等待LINE消息...');
});