const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ORDERS_FILE = path.join(__dirname, '../data/orders.json');
const EXPIRY_TIME = 7 * 24 * 60 * 60 * 1000; // 7 天

class OrderManager {
    constructor() {
        this.orders = new Map();
        this.ensureDataDirectory();
        this.loadOrders();
    }

    ensureDataDirectory() {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    loadOrders() {
        try {
            if (fs.existsSync(ORDERS_FILE)) {
                const data = fs.readFileSync(ORDERS_FILE, 'utf8');
                const ordersArray = JSON.parse(data);
                ordersArray.forEach(order => {
                    this.orders.set(order.orderId, order);
                });
                logger.logToFile(`✅ 載入 ${ordersArray.length} 筆訂單`);
            }
        } catch (error) {
            logger.logError('載入訂單失敗', error);
        }
    }

    saveOrders() {
        try {
            const ordersArray = Array.from(this.orders.values());
            fs.writeFileSync(ORDERS_FILE, JSON.stringify(ordersArray, null, 2), 'utf8');
        } catch (error) {
            logger.logError('儲存訂單失敗', error);
        }
    }

    createOrder(orderId, orderData) {
        const now = Date.now();
        const order = {
            orderId,
            userId: orderData.userId,
            userName: orderData.userName,
            amount: orderData.amount,
            status: 'pending',
            createdAt: now,
            expiryTime: now + EXPIRY_TIME,
            transactionId: null,
            paymentUrl: null,
            lastReminderSent: null,
            retryCount: 0,
            paymentMethod: null
        };
        this.orders.set(orderId, order);
        this.saveOrders();
        logger.logToFile(`✅ 建立訂單: ${orderId} - ${orderData.userName} - NT$ ${orderData.amount}`);
        return order;
    }

    getOrder(orderId) {
        return this.orders.get(orderId);
    }

    getAllOrders() {
        return Array.from(this.orders.values()).sort((a, b) => b.createdAt - a.createdAt);
    }

    getPendingOrders() {
        return this.getAllOrders().filter(order => order.status === 'pending' && !this.isExpired(order.orderId));
    }

    getOrdersByStatus(status) {
        return this.getAllOrders().filter(order => order.status === status);
    }

    getOrdersNeedingReminder() {
        const now = Date.now();
        const twoDaysAfterCreation = 0;         // 建立後立刻就可提醒
        const twoDaysInterval      = 60 * 1000; // 每 1 分鐘提醒一次


        
        return this.getPendingOrders().filter(order => {
            const timeSinceCreation = now - order.createdAt;
            
            // 建立後至少2天才開始提醒
            if (timeSinceCreation < twoDaysAfterCreation) {
                return false;
            }
            
            // 如果從未提醒過,應該提醒
            if (!order.lastReminderSent) {
                return true;
            }
            
            // 距離上次提醒已經超過2天,應該再次提醒
            const timeSinceLastReminder = now - order.lastReminderSent;
            return timeSinceLastReminder >= twoDaysInterval;
        });
    }

    updatePaymentInfo(orderId, transactionId, paymentUrl) {
        const order = this.orders.get(orderId);
        if (order) {
            order.transactionId = transactionId;
            order.paymentUrl = paymentUrl;
            order.retryCount++;
            this.saveOrders();
            logger.logToFile(`✅ 更新訂單付款資訊: ${orderId}`);
        }
    }

    updateOrderStatus(orderId, status, paymentMethod = null) {
        const order = this.orders.get(orderId);
        if (order) {
            order.status = status;
            if (status === 'paid') {
                order.paidAt = Date.now();
                order.paymentMethod = paymentMethod;
            }
            this.saveOrders();
            logger.logToFile(`✅ 更新訂單狀態: ${orderId} -> ${status} (${paymentMethod || '未知'})`);
        }
    }

    updateOrderStatusByUserId(userId, status, paymentMethod = null) {
        let updated = 0;
        for (const [orderId, order] of this.orders.entries()) {
            if (order.userId === userId && order.status === 'pending') {
                order.status = status;
                if (status === 'paid') {
                    order.paidAt = Date.now();
                    order.paymentMethod = paymentMethod;
                }
                updated++;
                logger.logToFile(`✅ 更新訂單狀態 (通過 userId): ${orderId} -> ${status} (${paymentMethod || '未知'})`);
            }
        }
        if (updated > 0) {
            this.saveOrders();
        }
        return updated;
    }

    markReminderSent(orderId) {
        const order = this.orders.get(orderId);
        if (order) {
            order.lastReminderSent = Date.now();
            this.saveOrders();
        }
    }

    isExpired(orderId) {
        const order = this.orders.get(orderId);
        if (!order) return true;
        return Date.now() > order.expiryTime;
    }

    deleteOrder(orderId) {
        const deleted = this.orders.delete(orderId);
        if (deleted) {
            this.saveOrders();
            logger.logToFile(`🗑️ 刪除訂單: ${orderId}`);
        }
        return deleted;
    }

    cleanExpiredOrders() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [orderId, order] of this.orders.entries()) {
            if (order.status === 'pending' && now > order.expiryTime) {
                this.orders.delete(orderId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.saveOrders();
            logger.logToFile(`🧹 清理 ${cleaned} 筆過期訂單`);
        }
        
        return cleaned;
    }

    renewOrder(orderId) {
        const order = this.orders.get(orderId);
        if (order) {
            const now = Date.now();
            order.expiryTime = now + EXPIRY_TIME;
            order.status = 'pending';
            order.retryCount = 0;
            order.lastReminderSent = null;
            this.saveOrders();
            logger.logToFile(`🔄 續約訂單: ${orderId} (新過期時間: 7天後)`);
            return order;
        }
        return null;
    }

    getOrderByUserIdAndAmount(userId, amount) {
        for (const [orderId, order] of this.orders.entries()) {
            if (order.userId === userId && order.amount === amount && order.status === 'pending') {
                return order;
            }
        }
        return null;
    }

    getStatistics() {
        const all = this.getAllOrders();
        return {
            total: all.length,
            pending: all.filter(o => o.status === 'pending' && !this.isExpired(o.orderId)).length,
            paid: all.filter(o => o.status === 'paid').length,
            expired: all.filter(o => o.status === 'pending' && this.isExpired(o.orderId)).length,
            needReminder: this.getOrdersNeedingReminder().length
        };
    }
}

module.exports = new OrderManager();
