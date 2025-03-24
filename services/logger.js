const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logFilePath = path.join(process.cwd(), 'logs.txt');
    }

    /**
     * 写入日志到文件
     * @param {string} message - 日志消息
     */
    logToFile(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} - ${message}\n`;

        fs.appendFile(this.logFilePath, logEntry, (err) => {
            if (err) {
                console.error('寫入日誌文件出錯:', err);
            }
        });
    }

    /**
     * 格式化用户消息日志
     * @param {string} userId - 用户ID
     * @param {string} message - 用户消息
     */
    logUserMessage(userId, message) {
        console.log(`用戶 ${userId} 發送了訊息: ${message}`);
        this.logToFile(`用戶 ${userId} 發送了訊息: ${message} (User ID: ${userId})`);
    }

    /**
     * 格式化机器人回复日志
     * @param {string} userId - 用户ID
     * @param {string} userMessage - 用户原始消息
     * @param {string} botResponse - 机器人回复内容
     * @param {string} [type='Bot'] - 回复类型
     */
    logBotResponse(userId, userMessage, botResponse, type = 'Bot') {
        console.log(`\n--------------------------------------------------------`);
        console.log(`|  用戶 ${userId} 訊息: ${userMessage}`);
        console.log(`|  ${type} 回覆用戶 ${userId}: ${botResponse}`);
        console.log(`--------------------------------------------------------\n`);
        this.logToFile(`${type} 回覆用戶 ${userId}: ${botResponse}(User ID: ${userId})`);
    }

    /**
     * 格式化错误日志
     * @param {string} errorType - 错误类型
     * @param {Error} error - 错误对象
     * @param {string} [userId] - 用户ID（可选）
     */
    logError(errorType, error, userId = '') {
        const userIdStr = userId ? `(User ID: ${userId})` : '';
        console.error(`${errorType}:`, error);
        this.logToFile(`${errorType}: ${error}${userIdStr}`);
    }

    /**
     * 记录图片分析结果
     * @param {string} userId - 用户ID
     * @param {string} analysisResult - 分析结果
     */
    logImageAnalysis(userId, analysisResult) {
        console.log(`\n--------------------------------------------------------`);
        console.log(`|  用戶 ${userId} 的圖片分析結果:`);
        console.log(`--------------------------------------------------------`);
        console.log(`${analysisResult}\n\n✨ 智能分析完成 👕`);
        this.logToFile(`用戶 ${userId} 的圖片分析結果:\n${analysisResult}\n✨ 智能分析完成 👕`);
    }

    /**
     * 获取日志文件路径
     * @returns {string} 日志文件路径
     */
    getLogFilePath() {
        return this.logFilePath;
    }
}

// 导出单例实例
module.exports = new Logger();
