const dayjs = require('dayjs');

// 动态回复逻辑（原Excel中的复杂条件判断）
function handleDynamicReceiving(text) {
  const now = dayjs();
  const hour = now.hour();
  const dayOfWeek = now.day(); // 0=周日, 6=周六
  
  console.log(`动态回复 - 当前时间: ${now.format('YYYY-MM-DD HH:mm:ss')}, 小时: ${hour}, 星期: ${dayOfWeek}`);

  // 判断逻辑
  if (/後天|大後天|兩天後/.test(text)) {
    console.log('匹配: 后天/大后天/两天后');
    return "可以的😊我們後天會去收回 🚚謝謝您。";
  }
  
  if (/明天|下週|幾號|某天|約時間|安排/.test(text)) {
    console.log('匹配: 明天/下周/几号/某天/约时间/安排');
    return "可以的😊我們明日會去收回 🚚謝謝您。";
  }
  
  if (dayOfWeek === 6) { // 周六
    console.log('今天是周六，安排明天收回');
    return "可以的😊因週六固定公休，我們明日會去收回 🚚謝謝您。";
  }
  
  if (/三重|新莊|土城|中和|永和/.test(text) || hour >= 17) {
    console.log('匹配: 特定地区或当前时间已晚，安排明天收回');
    return "可以的😊我們明日會去收回 🚚謝謝您。";
  }
  
  console.log('默认安排今天收回');
  return "可以的😊我們今日會去收回 🚚謝謝您。";
}

module.exports = { handleDynamicReceiving };