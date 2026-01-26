const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CUSTOMERS_FILE = path.join(__dirname, '../data/customers.json');

class CustomerDB {
    constructor() {
        this.customers = new Map();
        this.ensureDataDirectory();
    }

    ensureDataDirectory() {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        if (!fs.existsSync(CUSTOMERS_FILE)) {
            fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([], null, 2));
        }
    }

    async loadAllCustomers() {
        try {
            if (fs.existsSync(CUSTOMERS_FILE)) {
                const data = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
                const customersArray = JSON.parse(data);
                customersArray.forEach(customer => {
                    this.customers.set(customer.userId, customer);
                });
                logger.logToFile(`✅ 載入 ${customersArray.length} 位客戶`);
            }
        } catch (error) {
            logger.logError('載入客戶資料失敗', error);
        }
    }

    saveCustomers() {
        try {
            const customersArray = Array.from(this.customers.values());
            fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customersArray, null, 2), 'utf8');
        } catch (error) {
            logger.logError('儲存客戶資料失敗', error);
        }
    }

    async addOrUpdateCustomer(customerData) {
        try {
            const existing = this.customers.get(customerData.userId);
            const customer = {
                ...existing,
                ...customerData,
                lastUpdated: Date.now()
            };
            this.customers.set(customerData.userId, customer);
            this.saveCustomers();
            return customer;
        } catch (error) {
            logger.logError('新增/更新客戶失敗', error);
            throw error;
        }
    }

    getCustomer(userId) {
        return this.customers.get(userId);
    }

    getAllCustomers() {
        return Array.from(this.customers.values()).sort((a, b) => 
            (b.lastInteraction || 0) - (a.lastInteraction || 0)
        );
    }

    deleteCustomer(userId) {
        const deleted = this.customers.delete(userId);
        if (deleted) {
            this.saveCustomers();
            logger.logToFile(`🗑️ 刪除客戶: ${userId}`);
        }
        return deleted;
    }
}

module.exports = new CustomerDB();
