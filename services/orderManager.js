const logger = require('./logger');

class OrderManager {
    constructor() {
        this.orders = new Map();
    }

    createOrder(orderId, data) {
        const expiryTime = Date.now() + (168 * 60 * 60 * 1000);
        
        const order = {
            orderId: orderId,
            userId: data.userId,
            userName: data.userName,
            amount: data.amount,
            status: 'pending',
            createdAt: Date.now(),
            expiryTime: expiryTime,
            lastPaymentUrl: null,
            lastTransactionId: null
        };
        
        this.orders.set(orderId, order);
        logger.logToFile(`✅ 已建立訂單: ${orderId}, 過期時間: ${new Date(expiryTime).toLocaleString('zh-TW')}`);
        
        return order;
    }

    getOrder(orderId) {
        return this.orders.get(orderId);
    }

    isExpired(orderId) {
        const order = this.orders.get(orderId);
        if (!order) return true;
        return Date.now() > order.expiryTime;
    }

    updatePaymentInfo(orderId, transactionId, paymentUrl) {
        const order = this.orders.get(orderId);
        if (order) {
            order.lastTransactionId = transactionId;
            order.lastPaymentUrl = paymentUrl;
            order.lastUpdated = Date.now();
            this.orders.set(orderId, order);
        }
    }

    updateOrderStatus(orderId, status) {
        const order = this.orders.get(orderId);
        if (order) {
            order.status = status;
            order.paidAt = Date.now();
            this.orders.set(orderId, order);
            logger.logToFile(`✅ 訂單狀態更新: ${orderId} -> ${status}`);
        }
    }

    cleanExpiredOrders() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [orderId, order] of this.orders.entries()) {
            if (now > order.expiryTime && order.status === 'pending') {
                this.orders.delete(orderId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            logger.logToFile(`🗑️ 清理了 ${cleaned} 個過期訂單`);
        }
        
        return cleaned;
    }
}

module.exports = new OrderManager();
