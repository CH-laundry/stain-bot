// services/imageHandler.js
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const SAVE_DIR = "/data/uploads"; // 永久 Volume 路徑
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

async function handleImageMessage(event, client) {
  try {
    const messageId = event.message.id;
    const ext = ".jpg";
    const fileName = `${messageId}${ext}`;
    const filePath = path.join(SAVE_DIR, fileName);

    const stream = await client.getMessageContent(messageId);
    await pipeline(stream, fs.createWriteStream(filePath));

    const publicUrl = `${process.env.APP_URL || "https://stain-bot-production-2593.up.railway.app"}/files/${fileName}`;
    console.log(`✅ 圖片已儲存: ${filePath}`);
    return publicUrl;
  } catch (err) {
    console.error("❌ handleImageMessage 錯誤:", err);
    return null;
  }
}

module.exports = { handleImageMessage };
