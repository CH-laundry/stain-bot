const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// 测试用例列表
const testCases = [
  {
    name: '洗衣请求测试',
    body: {
      "events": [{
        "type": "message",
        "replyToken": "test-reply-token",
        "source": {
          "userId": "test-user-id",
          "type": "user"
        },
        "message": {
          "type": "text",
          "text": "我要送洗衣服，你们什么时候来收"
        }
      }]
    }
  },
  {
    name: '营业时间查询测试',
    body: {
      "events": [{
        "type": "message",
        "replyToken": "test-reply-token",
        "source": {
          "userId": "test-user-id",
          "type": "user"
        },
        "message": {
          "type": "text",
          "text": "營業時間是幾點到幾點"
        }
      }]
    }
  },
  {
    name: '地址检测测试',
    body: {
      "events": [{
        "type": "message",
        "replyToken": "test-reply-token",
        "source": {
          "userId": "test-user-id",
          "type": "user",
          "displayName": "台北市大安區和平東路二段106號"
        },
        "message": {
          "type": "text",
          "text": "请送回我的衣服"
        }
      }]
    }
  }
];

async function testWebhook(testCase) {
  try {
    console.log(`\n=== 测试用例: ${testCase.name} ===`);
    
    // 生成签名
    const stringifiedBody = JSON.stringify(testCase.body);
    const signature = crypto
      .createHmac('SHA256', process.env.LINE_CHANNEL_SECRET)
      .update(Buffer.from(stringifiedBody))
      .digest('base64');
    
    console.log('Request Body:', stringifiedBody);
    console.log('Generated Signature:', signature);
    
    // 发送请求
    console.log('\n发送请求...');
    const response = await axios.post('http://localhost:3000/webhook', testCase.body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature
      }
    });
    
    console.log('Status:', response.status);
    console.log('Response:', response.data || '无响应数据');
    console.log('测试通过 ✅');
  } catch (error) {
    console.error('测试失败 ❌');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

async function runAllTests() {
  console.log('=== LINE Webhook 测试开始 ===');
  console.log('Channel Secret:', process.env.LINE_CHANNEL_SECRET);
  
  for (const testCase of testCases) {
    await testWebhook(testCase);
  }
  
  console.log('\n=== 测试完成 ===');
}

runAllTests(); 