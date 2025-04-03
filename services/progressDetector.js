function isProgressQuery(text) {
  const keywords = [
    "洗好了嗎", "完成了嗎", "好了嗎", "可以拿了嗎", "可以取了嗎", 
    "收回來了嗎", "收過了嗎", "什麼時候收", "已經收了嗎", 
    "什麼時候會來", "收件了嗎", "還沒收", "來拿了嗎"
  ];
  return keywords.some(k => text.includes(k));
}

function getProgressReply() {
  return {
    type: "text",
    text: "營業時間我們會馬上查詢您的清洗進度😊，也可以透過以下連結自行查詢唷～\n👉 點我查詢 C.H精緻洗衣",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "uri",
            label: "C.H精緻洗衣",
            uri: "https://liff.line.me/2004612704-JnzA1qN6#/"
          }
        }
      ]
    }
  };
}

module.exports = { isProgressQuery, getProgressReply };
