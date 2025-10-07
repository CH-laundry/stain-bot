const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../logs.txt');

/**
 * 記錄到檔案
 */
function logToFile(message) {
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const logMessage = `[${timestamp}] ${message}\n`;
    
    try {
        fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
    } catch (err) {
        console.error('寫入日誌失敗:', err);
    }
}

/**
 * 記錄用戶訊息
 */
function logUserMessage(userId, message) {
    logToFile(`用戶 ${userId}: ${message}`);
}

/**
 * 記錄錯誤
 */
function logError(context, error, userId = '') {
    const userInfo = userId ? ` [用戶: ${userId}]` : '';
    logToFile(`❌ 錯誤${userInfo} - ${context}: ${error.message || error}`);
    if (error.stack) {
        logToFile(`堆疊: ${error.stack}`);
    }
}

/**
 * 取得日誌檔案路徑
 */
function getLogFilePath() {
    return LOG_FILE;
}

module.exports = {
    logToFile,
    logUserMessage,
    logError,
    getLogFilePath
};
