// ============== 引入依賴 ==============
const fs = require('fs');

const express = require('express');
require('dotenv').config();

// 添加必要的引用
const logger = require('./services/logger');
const messageHandler = require('./services/message');

console.log(`正在初始化 sheet.json: ${process.env.GOOGLE_PRIVATE_KEY ? '成功' : '失敗'}`);
fs.writeFileSync("./sheet.json", process.env.GOOGLE_PRIVATE_KEY);
console.log(`sheet.json 初始化结束`);

const app = express();
app.use(express.json());

// ============== 核心邏輯 ==============
app.post('/webhook', async (req, res) => {
    res.status(200).end();

    try {
        const events = req.body.events;

        for (const event of events) {
            try {
                if (event.type !== 'message' || !event.source.userId) continue;

                const userId = event.source.userId;
                let userMessage = '';
                
                if (event.message.type === 'text') {
                    userMessage = event.message.text.trim();
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleTextMessage(userId, userMessage, userMessage);
                } else if (event.message.type === 'image') {
                    userMessage = '上傳了一張圖片';
                    logger.logUserMessage(userId, userMessage);
                    await messageHandler.handleImageMessage(userId, event.message.id);
                } else {
                    userMessage = '發送了其他類型的訊息';
                    logger.logUserMessage(userId, userMessage);
                }

            } catch (err) {
                // logger.logError('處理事件時出錯', err, event.source?.userId);
            }
        }
    } catch (err) {
        logger.logError('全局錯誤', err);
    }
});

// ============== 下載日誌文件 ==============
app.get('/log', (req, res) => {
    res.download(logger.getLogFilePath(), 'logs.txt', (err) => {
        if (err) {
            logger.logError('下載日誌文件出錯', err);
            res.status(500).send('下載文件失敗');
        }
    });
});

// ✅ 新增首頁顯示狀態用，讓 Railway/UptimeRobot 不會 404
app.get('/', (req, res) => {
    res.send('C.H 精緻洗衣的機器人正在運作中 ✅');
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器正在運行，端口：${PORT}`);
    logger.logToFile(`伺服器正在運行，端口：${PORT}`);
});
