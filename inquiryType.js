const { readAllSheetData } = require('./services/google');
const logger = require('./services/logger');

/**
 * @type {Array<{keywords: string[], language: string, response: string}>}
 */
let inquiryData = []

const detectInquiryType = (text) => {
    const lowerText = text.toLowerCase()

    for (const inquiry of inquiryData) {
        const keywords = inquiry.keywords.split(',')
        for (const keyword of keywords) {
            if (lowerText.includes(keyword.toLowerCase())) {
                logger.logToFile(`找到關鍵字: ${keyword} -> ${inquiry.response}`)

                return inquiry.response
            }
        }
    }
    
    return null
}

setInterval(async () => {
    inquiryData = await readAllSheetData()
}, 30 * 60 * 1000);

console.log('讀取 Google Sheets 資料')
readAllSheetData().then(data => {
    console.log('讀取 Google Sheets 資料完成')
    inquiryData = data
})

module.exports = {
    detectInquiryType
}
