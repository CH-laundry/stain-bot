const dayjs = require('dayjs');

// 动态回复逻辑（原Excel中的复杂条件判断）
function handleDynamicReceiving(text) {
  const now = dayjs();
  const hour = now.hour();
  const dayOfWeek = now.day(); // 0=周日, 6=周六

  // 判断逻辑
  if (/後天|大後天|兩天後/.test(text)) {
    return "可以的😊我們後天會去收回 🚚謝謝您。";
  }
  if (/明天|下週|幾號|某天|約時間|安排/.test(text)) {
    return "可以的😊我們明日會去收回 🚚謝謝您。";
  }
  if (dayOfWeek === 6) { // 周六
    return "可以的😊因週六固定公休，我們明日會去收回 🚚謝謝您。";
  }
  if (/三重|新莊|土城|中和|永和/.test(text) || hour >= 17) {
    return "可以的😊我們明日會去收回 🚚謝謝您。";
  }
  return "可以的😊我們今日會去收回 🚚謝謝您。";
}

module.exports = { handleDynamicReceiving };
