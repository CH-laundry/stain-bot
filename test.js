// 测试脚本 - 模拟用户发送消息
require('dotenv').config();
const SheetsReply = require('./sheetsReply');
const AddressDetector = require('./addressDetector');
const { handleDynamicReceiving } = require('./dynamicReply');
const keywordRules = require('./keywordRules');

// 创建一个模拟的LINE客户端
const mockClient = {
  replyMessage: (token, message) => {
    console.log('\n===== 机器人回复 =====');
    console.log(message.text);
    console.log('=======================\n');
    return Promise.resolve();
  }
};

// 初始化Sheets回复
const sheetsReply = new SheetsReply();

// 模拟处理消息的函数
async function testMessage(userName, text) {
  console.log(`\n测试用户: ${userName}`);
  console.log(`测试消息: ${text}`);
  
  try {
    // 1. 检查用户名称是否包含地址，并且内容有「送回」「送还」「拿回来」
    if (AddressDetector.isAddress(userName) && /(送回|送還|拿回來)/.test(text)) {
      const replyMsg = AddressDetector.formatResponse(userName);
      return mockClient.replyMessage('test-token', { type: 'text', text: replyMsg });
    }

    // 2. 从Sheets获取回复
    await sheetsReply.loadData();
    const sheetsResponse = sheetsReply.getReply(text);
    if (sheetsResponse && sheetsResponse !== '📥 已记录问题将转交客服处理') {
      return mockClient.replyMessage('test-token', { type: 'text', text: sheetsResponse });
    }

    // 3. 检查动态收送回复
    if (/(收件|取件|來拿|幫忙收|幫忙拿|預約|送來|送出|要洗|來收|來取|送洗)/.test(text)) {
      const dynamicResponse = handleDynamicReceiving(text);
      return mockClient.replyMessage('test-token', { type: 'text', text: dynamicResponse });
    }

    // 4. 检查关键字规则
    for (let rule of keywordRules) {
      if (rule.keywords.some(keyword => text.includes(keyword))) {
        const response = typeof rule.response === 'function' 
          ? rule.response(text) 
          : rule.response;
        return mockClient.replyMessage('test-token', { type: 'text', text: response });
      }
    }

    // 5. 检查是否与洗衣相关
    function isLaundryRelatedText(text) {
      const lowerText = text.toLowerCase();
      const keywords = [
        "洗衣", "清洗", "污漬", "油漬", "血漬", "醬油", "染色", "退色", "地毯", "窗簾", 
        "寶寶汽座", "汽座", "兒童座椅", "安全兒童座椅", "手推車", "單人手推車", "寶寶手推車", 
        "書包", "營業", "開門", "休息", "開店", "有開", "收送", "到府", "上門", "收衣", "預約",
        "價格", "价錢", "收費", "費用", "多少錢", "價位", "算錢", "清洗費", "價目表"
      ];
      
      return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
    }

    if (isLaundryRelatedText(text)) {
      return mockClient.replyMessage('test-token', { 
        type: 'text', 
        text: '您可以參考我們的常見問題或按『3』😊，詳細問題營業時間內線上客服會跟您回覆，謝謝您！🙏😊'
      });
    }

    // 6. 如果与洗衣无关，不回应
    console.log('消息与洗衣无关，不回应');
    
  } catch (error) {
    console.error('处理消息时出错:', error);
  }
}

// 测试用例
async function runTests() {
  // 测试1: 地址检测
  await testMessage('台北市大安區和平東路二段106號', '请送回我的衣服');
  
  // 测试2: Sheets回复
  await testMessage('张三', '洗好了吗');
  
  // 测试3: 动态收送回复
  await testMessage('李四', '我要送洗衣服，你们什么时候来收');
  
  // 测试4: 关键字规则
  await testMessage('王五', '营业时间是几点到几点');
  
  // 测试5: 洗衣相关但没有触发关键字
  await testMessage('赵六', '我的衣服怎么样了');
  
  // 测试6: 与洗衣无关
  await testMessage('钱七', '你好，请问你是谁');
}

// 运行测试
runTests().catch(console.error); 