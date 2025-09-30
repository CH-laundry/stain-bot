// app.js / index.js (示例)
const messageHandler = require('./services/message');

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(async (event) => {
    const userId = event.source?.userId;
    if (!userId) return;

    if (event.type === 'message' && event.message.type === 'text') {
      return messageHandler.handleTextMessage(
        userId,
        event.message.text,
        event.message,
        event.replyToken // ← 一定要傳
      );
    }
    if (event.type === 'message' && event.message.type === 'image') {
      return messageHandler.handleImageMessage(userId, event.message.id);
    }
  }))
  .then(() => res.status(200).end())
  .catch((err) => { console.error('Webhook error:', err); res.status(500).end(); });
});
