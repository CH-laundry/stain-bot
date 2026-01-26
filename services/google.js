const { google } = require('googleapis');
const path = require('path');

// 创建授权客户端
function getAuthClient() {
    console.log(`========== 获取授权客户端 ==========`);
    console.log(`客户端时间: ${new Date().toISOString()}`);
    console.log(`当前工作目录: ${process.cwd()}`);
    console.log(`keyFile: ${path.join(process.cwd(), 'sheet.json')}`);
    console.log(`scopes: ${['https://www.googleapis.com/auth/spreadsheets']}`);
    console.log(`========== 获取授权客户端结束 ==========`);

    const auth = new google.auth.GoogleAuth({
        keyFile: path.join(process.cwd(), 'sheet.json'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return auth;
}

/**
 * 获取工作表的所有数据
 * @returns {Promise<Array>} - 返回数据数组
 */
async function readAllSheetData() {
    try {
        const auth = await getAuthClient();
        // 修改 errorRedactor 显示所有错误
        const sheets = google.sheets({ version: 'v4', auth });

        // 首先获取工作表信息
        const sheetMetadata = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        });

        // 获取第一个工作表的标题
        const firstSheet = sheetMetadata.data.sheets[0];
        const sheetTitle = firstSheet.properties.title;

        // 获取工作表数据
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `${sheetTitle}`,  // 读取整个工作表
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            console.log('未找到数据');
            return [];
        }

        // 获取表头（第一行）
        const headers = rows[0];

        const headersMap = [
            "keywords",
            "language",
            "response"
        ]

        // 将数据转换为JSON格式
        const jsonData = rows.slice(1).map(row => {
            const item = {};
            headers.forEach((header, index) => {
                item[headersMap[index]] = row[index] || '';
            });
            return item;
        });

        return jsonData;

    } catch (error) {
        console.error('读取 Google Sheets 时出错:', error.message);
        if (error.message.includes('Unable to parse range')) {
            console.error('范围格式错误，请检查工作表名称和范围格式');
        }
        throw error;
    }
}

/**
 * 从Google Sheets读取指定范围的数据
 * @param {string} sheetName - 工作表名称
 * @param {string} startCell - 起始单元格（例如: 'A1'）
 * @param {string} endCell - 结束单元格（例如: 'D10'）
 * @returns {Promise<Array>} - 返回数据数组
 */
async function readSheetRange(sheetName, startCell = 'A1', endCell) {
    try {
        const auth = await getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        let range;
        if (endCell) {
            range = `${sheetName}!${startCell}:${endCell}`;
        } else {
            range = `${sheetName}!${startCell}`;
        }

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: range,
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            console.log('指定范围内未找到数据');
            return [];
        }

        // 获取表头（第一行）
        const headers = rows[0];

        // 将数据转换为JSON格式
        const jsonData = rows.slice(1).map(row => {
            const item = {};
            headers.forEach((header, index) => {
                item[header] = row[index] || '';
            });
            return item;
        });

        return jsonData;

    } catch (error) {
        console.error('读取 Google Sheets 时出错:', error.message);
        if (error.message.includes('Unable to parse range')) {
            console.error('范围格式错误，请检查工作表名称和范围格式');
        }
        throw error;
    }
}

/**
 * 添加客户信息到工作表
 * @param {Object} customerInfo - 客户信息对象
 * @returns {Promise<void>}
 */
async function addCustomerInfo(customerInfo) {
    try {
        const auth = await getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        // 获取当前时间
        const now = new Date();
        const timestamp = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

        // 准备要插入的数据
        const values = [[
            timestamp,              // 时间戳
            customerInfo.userId,    // LINE用户ID
            customerInfo.userName,  // LINE用户名称
            customerInfo.address,   // 地址
            'pending'              // 状态
        ]];

        // 插入数据到第二个工作表
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: '客戶資料!A:E',  // 指定第二个工作表
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: values
            },
        });

        console.log('客户信息已添加到工作表');
        return true;

    } catch (error) {
        console.error('添加客户信息时出错:', error.message);
        throw error;
    }
}

module.exports = {
    readAllSheetData,
    readSheetRange,
    addCustomerInfo
};
