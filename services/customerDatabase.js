const logger = require('./logger');
const fs = require('fs');
const path = require('path');

class CustomerDatabase {
    constructor() {
        this.DATA_FILE = '/data/customers.json';
        this.cache = new Map();
        this.ensureDataFile();
    }

    ensureDataFile() {
        const dir = path.dirname(this.DATA_FILE);
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        if (!fs.existsSync(this.DATA_FILE)) {
            fs.writeFileSync(this.DATA_FILE, JSON.stringify([]), 'utf8');
        }
    }

    async loadAllCustomers() {
        try {
            if (!fs.existsSync(this.DATA_FILE)) {
                logger.logToFile('⚠️ 客戶資料檔案不存在，建立新檔案');
                this.ensureDataFile();
                return;
            }

            const data = fs.readFileSync(this.DATA_FILE, 'utf8');
            const customers = JSON.parse(data);
            
            customers.forEach(customer => {
                if (customer.userId) {
                    this.cache.set(customer.userId, customer);
                }
            });

            logger.logToFile(`✅ 已從檔案載入 ${customers.length} 位客戶`);
        } catch (error) {
            logger.logError('載入客戶資料失敗', error);
        }
    }

    saveToFile() {
        try {
            const customers = Array.from(this.cache.values());
            fs.writeFileSync(this.DATA_FILE, JSON.stringify(customers, null, 2), 'utf8');
        } catch (error) {
            logger.logError('儲存客戶資料到檔案失敗', error);
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
                customName: !!(realName || existing?.realName),
                firstContact: existing?.firstContact || now,
                lastContact: now,
                messageCount: existing?.messageCount || 0
            };

            this.cache.set(userId, customerData);
            this.saveToFile();

            logger.logToFile(`✅ 已儲存客戶: ${displayName} (${userId})`);
            return customerData;

        } catch (error) {
            logger.logError('儲存客戶資料失敗', error);
            return null;
        }
    }

    async updateCustomerActivity(userId, message) {
        try {
            const existing = this.cache.get(userId);
            
            if (existing) {
                const now = new Date().toISOString();
                
                existing.lastContact = now;
                existing.messageCount = (existing.messageCount || 0) + 1;
                
                if (message && message.type === 'text') {
                    existing.lastMessage = message.text;
                }
                
                this.cache.set(userId, existing);
                this.saveToFile();
                
                logger.logToFile(`✅ 客人活動已更新: ${existing.displayName} (訊息數: ${existing.messageCount})`);
            }
        } catch (error) {
            logger.logError('更新客人活動失敗', error, userId);
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
            new Date(b.lastContact || b.lastSeen) - new Date(a.lastContact || a.lastSeen)
        );
    }

    getCustomer(userId) {
        // 👇👇👇 插入開始：測試用強制通道 👇👇👇
        if (userId === 'U5099169723d6e83588c5f23dfaf6f9cf') {
            return {
                userId: userId,
                displayName: '小林王子大大',
                realName: '625',  // 強制讓系統以為你是 625 號客人
                lastContact: new Date().toISOString()
            };
        }
        // 👆👆👆 插入結束 👆👆👆
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
