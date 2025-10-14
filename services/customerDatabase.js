const { google } = require('googleapis');
const googleAuth = require('./googleAuth');
const logger = require('./logger');

class CustomerDatabase {
    constructor() {
        this.SHEET_NAME = '客戶列表';
        this.cache = new Map();
    }

    async getSheets() {
        const auth = googleAuth.getOAuth2Client();
        return google.sheets({ version: 'v4', auth });
    }

    async loadAllCustomers() {
        try {
            if (!googleAuth.isAuthorized()) {
                logger.logToFile('⚠️ Google 未授權,跳過載入客戶資料');
                return;
            }

            const sheets = await this.getSheets();
            const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

            if (!spreadsheetId) {
                logger.logToFile('⚠️ 未設定 GOOGLE_SHEETS_ID_CUSTOMER');
                return;
            }

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: `${this.SHEET_NAME}!A2:F`
            });

            const rows = response.data.values || [];
            
            rows.forEach(row => {
                if (row[1]) {
                    this.cache.set(row[1], {
                        userId: row[1],
                        displayName: row[2] || '',
                        realName: row[3] || '',
                        lastSeen: row[4] || new Date().toISOString(),
                        interactionCount: parseInt(row[5]) || 0,
                        customName: !!row[3]
                    });
                }
            });

            logger.logToFile(`✅ 已從 Google Sheets 載入 ${rows.length} 位客戶`);
        } catch (error) {
            logger.logError('載入客戶資料失敗', error);
        }
    }

    async saveCustomer(userId, displayName, realName = '') {
        try {
            const now = new Date().toISOString();
            const existing = this.cache.get(userId);

            const customerData = {
                userId: userId,
                displayName: displayName,
                realName: realName || existing?.realName || '',
                lastSeen: now,
                interactionCount: (existing?.interactionCount || 0) + 1,
                customName: !!(realName || existing?.realName)
            };

            this.cache.set(userId, customerData);

            if (!googleAuth.isAuthorized()) {
                return customerData;
            }

            const sheets = await this.getSheets();
            const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CUSTOMER;

            if (!spreadsheetId) {
                return customerData;
            }

            const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

            if (existing) {
                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: `${this.SHEET_NAME}!B:B`
                });

                const rows = response.data.values || [];
                const rowIndex = rows.findIndex(row => row[0] === userId);

                if (rowIndex !== -1) {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: spreadsheetId,
                        range: `${this.SHEET_NAME}!A${rowIndex + 2}:F${rowIndex + 2}`,
                        valueInputOption: 'USER_ENTERED',
                        resource: {
                            values: [[
                                timestamp,
                                userId,
                                displayName,
                                customerData.realName,
                                now,
                                customerData.interactionCount
                            ]]
                        }
                    });
                    logger.logToFile(`✅ 已更新客戶: ${displayName} (${userId})`);
                    return customerData;
                }
            }

            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `${this.SHEET_NAME}!A:F`,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[
                        timestamp,
                        userId,
                        displayName,
                        customerData.realName,
                        now,
                        customerData.interactionCount
                    ]]
                }
            });

            logger.logToFile(`✅ 已新增客戶: ${displayName} (${userId})`);
            return customerData;

        } catch (error) {
            logger.logError('儲存客戶資料失敗', error);
            return null;
        }
    }

    async updateCustomerName(userId, realName) {
        try {
            const customer = this.cache.get(userId);
            if (!customer) {
                throw new Error('找不到此客戶');
            }

            return await this.saveCustomer(userId, customer.displayName, realName);
        } catch (error) {
            logger.logError('更新客戶名稱失敗', error);
            throw error;
        }
    }

    getAllCustomers() {
        return Array.from(this.cache.values()).sort((a, b) => 
            new Date(b.lastSeen) - new Date(a.lastSeen)
        );
    }

    getCustomer(userId) {
        return this.cache.get(userId);
    }

    searchCustomers(searchTerm) {
        const term = searchTerm.toLowerCase();
        return this.getAllCustomers().filter(customer =>
            customer.displayName.toLowerCase().includes(term) ||
            customer.realName.toLowerCase().includes(term) ||
            customer.userId.toLowerCase().includes(term)
        );
    }
}

module.exports = new CustomerDatabase();
