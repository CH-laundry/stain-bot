const crypto = require('crypto');
require('dotenv').config();

// 最简单的测试消息
const testBody = {
  "events": [{
    "type": "message",
    "message": {
      "type": "text",
      "text": "hi"
    }
  }]
};

// 确保JSON字符串的一致性
const stringifiedBody = JSON.stringify(testBody);

// 生成签名
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const signature = crypto
  .createHmac('SHA256', channelSecret)
  .update(Buffer.from(stringifiedBody))
  .digest('base64');

// 输出详细的调试信息
console.log('=== Debug Information ===');
console.log('1. Channel Secret:', channelSecret);
console.log('2. Raw Body Object:', testBody);
console.log('3. Stringified Body:', stringifiedBody);
console.log('4. Body Buffer Length:', Buffer.from(stringifiedBody).length);
console.log('5. Generated Signature:', signature);

console.log('\n=== Postman Test Instructions ===');
console.log('1. Create a new POST request to: http://localhost:3000/webhook');
console.log('\n2. Add these EXACT headers:');
console.log('Content-Type: application/json');
console.log(`X-Line-Signature: ${signature}`);
console.log('\n3. Add this EXACT body (do not format or modify):');
console.log(stringifiedBody);

console.log('\n=== Alternative: cURL Command ===');
console.log(`curl -v -X POST http://localhost:3000/webhook \\
  -H 'Content-Type: application/json' \\
  -H 'X-Line-Signature: ${signature}' \\
  -d '${stringifiedBody}'`);

// 额外验证
const verifySignature = crypto
  .createHmac('SHA256', channelSecret)
  .update(Buffer.from(stringifiedBody))
  .digest('base64');

console.log('\n=== Verification ===');
console.log('Verification Signature:', verifySignature);
console.log('Signatures Match:', signature === verifySignature); 