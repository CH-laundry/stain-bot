const { pool } = require('./database');
const logger = require('./logger');

const EXPIRY_TIME = 7 * 24 * 60 * 60 * 1000;

class OrderManagerDB {
    constructor() {
        console.log('✅ OrderManagerDB 初始化');
    }

    async createOrder(orderId, orderData) {
        try {
            const now = Date.now();
            const query = `
                INSERT INTO orders (
                    order_id, user_id, user_name, amount, status,
                    created_at, expiry_time, transaction_id, payment_url,
                    last_reminder_sent, retry_count, payment_method
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *
            `;
            const values = [
                orderId,
                orderData.userId,
                orderData.userName,
                orderData.amount,
                'pending',
                now,
                now + EXPIRY_TIME,
                null,
                null,
                null,
                0,
                null
            ];
            const result = await pool.query(query, values);
            logger.logToFile(`✅ 建立訂單: ${orderId} - ${orderData.userName} - NT$ ${orderData.amount}`);
            return result.rows[0];
        } catch (error) {
            logger.logError('建立訂單失敗', error);
            throw error;
        }
    }

    async getOrder(orderId) {
        try {
            const result = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
            return result.rows[0] || null;
        } catch (error) {
            logger.logError('取得訂單失敗', error);
            return null;
        }
    }

    async getAllOrders() {
        try {
            const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
            return result.rows;
        } catch (error) {
            logger.logError('取得所有訂單失敗', error);
            return [];
        }
    }

    async getPendingOrders() {
        try {
            const now = Date.now();
            const result = await pool.query(
                'SELECT * FROM orders WHERE status = $1 AND expiry_time > $2 ORDER BY created_at DESC',
                ['pending', now]
            );
            return result.rows;
        } catch (error) {
            logger.logError('取得待付款訂單失敗', error);
            return [];
        }
    }

    async getOrdersByStatus(status) {
        try {
            const result = await pool.query(
                'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC',
                [status]
            );
            return result.rows;
        } catch (error) {
            logger.logError('按狀態取得訂單失敗', error);
            return [];
        }
    }

    async getOrdersNeedingReminder() {
        try {
            const now = Date.now();
            const twoDaysAfterCreation = 2 * 24 * 60 * 60 * 1000;
            const twoDaysInterval = 2 * 24 * 60 * 60 * 1000;
            
            const result = await pool.query(`
                SELECT * FROM orders 
                WHERE status = 'pending' 
                AND expiry_time > $1
                AND (created_at + $2) <= $1
                AND (
                    last_reminder_sent IS NULL 
                    OR (last_reminder_sent + $3) <= $1
                )
                ORDER BY created_at ASC
            `, [now, twoDaysAfterCreation, twoDaysInterval]);
            
            return result.rows;
        } catch (error) {
            logger.logError('取得需提醒訂單失敗', error);
            return [];
        }
    }
  async updatePaymentInfo(orderId, transactionId, paymentUrl) {
        try {
            const query = `
                UPDATE orders 
                SET transaction_id = $1, payment_url = $2, retry_count = retry_count + 1
                WHERE order_id = $3
                RETURNING *
            `;
            const result = await pool.query(query, [transactionId, paymentUrl, orderId]);
            logger.logToFile(`✅ 更新訂單付款資訊: ${orderId}`);
            return result.rows[0] || null;
        } catch (error) {
            logger.logError('更新付款資訊失敗', error);
            throw error;
        }
    }

    async updateOrderStatus(orderId, status, paymentMethod = null) {
        try {
            const paidAt = status === 'paid' ? Date.now() : null;
            const query = `
                UPDATE orders 
                SET status = $1, payment_method = $2, paid_at = $3
                WHERE order_id = $4
                RETURNING *
            `;
            const result = await pool.query(query, [status, paymentMethod, paidAt, orderId]);
            logger.logToFile(`✅ 更新訂單狀態: ${orderId} -> ${status} (${paymentMethod || '未知'})`);
            return result.rows[0] || null;
        } catch (error) {
            logger.logError('更新訂單狀態失敗', error);
            throw error;
        }
    }

    async updateOrderStatusByUserId(userId, status, paymentMethod = null) {
        try {
            const paidAt = status === 'paid' ? Date.now() : null;
            const query = `
                UPDATE orders 
                SET status = $1, payment_method = $2, paid_at = $3
                WHERE user_id = $4 AND status = 'pending'
                RETURNING *
            `;
            const result = await pool.query(query, [status, paymentMethod, paidAt, userId]);
            logger.logToFile(`✅ 更新訂單狀態 (通過 userId): ${result.rowCount} 筆訂單 -> ${status} (${paymentMethod || '未知'})`);
            return result.rowCount;
        } catch (error) {
            logger.logError('批量更新訂單狀態失敗', error);
            return 0;
        }
    }

    async markReminderSent(orderId) {
        try {
            const now = Date.now();
            await pool.query(
                'UPDATE orders SET last_reminder_sent = $1 WHERE order_id = $2',
                [now, orderId]
            );
        } catch (error) {
            logger.logError('標記提醒失敗', error);
        }
    }

    isExpired(order) {
        if (!order) return true;
        return Date.now() > order.expiry_time;
    }

    async deleteOrder(orderId) {
        try {
            const result = await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
            if (result.rowCount > 0) {
                logger.logToFile(`🗑️ 刪除訂單: ${orderId}`);
                return true;
            }
            return false;
        } catch (error) {
            logger.logError('刪除訂單失敗', error);
            return false;
        }
    }

    async cleanExpiredOrders() {
        try {
            const now = Date.now();
            const result = await pool.query(
                'DELETE FROM orders WHERE status = $1 AND expiry_time < $2',
                ['pending', now]
            );
            if (result.rowCount > 0) {
                logger.logToFile(`🧹 清理 ${result.rowCount} 筆過期訂單`);
            }
            return result.rowCount;
        } catch (error) {
            logger.logError('清理過期訂單失敗', error);
            return 0;
        }
    }

    async renewOrder(orderId) {
        try {
            const now = Date.now();
            const query = `
                UPDATE orders 
                SET expiry_time = $1, status = 'pending', retry_count = 0, last_reminder_sent = NULL
                WHERE order_id = $2
                RETURNING *
            `;
            const result = await pool.query(query, [now + EXPIRY_TIME, orderId]);
            if (result.rows[0]) {
                logger.logToFile(`🔄 續約訂單: ${orderId} (新過期時間: 7天後)`);
                return result.rows[0];
            }
            return null;
        } catch (error) {
            logger.logError('續約訂單失敗', error);
            return null;
        }
    }
  async getOrderByUserIdAndAmount(userId, amount) {
        try {
            const result = await pool.query(
                'SELECT * FROM orders WHERE user_id = $1 AND amount = $2 AND status = $3 ORDER BY created_at DESC LIMIT 1',
                [userId, amount, 'pending']
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.logError('查找訂單失敗', error);
            return null;
        }
    }

    async getStatistics() {
        try {
            const now = Date.now();
            const total = await pool.query('SELECT COUNT(*) FROM orders');
            const pending = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1 AND expiry_time > $2', ['pending', now]);
            const paid = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', ['paid']);
            const expired = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1 AND expiry_time < $2', ['pending', now]);
            const needReminder = await this.getOrdersNeedingReminder();
            
            return {
                total: parseInt(total.rows[0].count),
                pending: parseInt(pending.rows[0].count),
                paid: parseInt(paid.rows[0].count),
                expired: parseInt(expired.rows[0].count),
                needReminder: needReminder.length
            };
        } catch (error) {
            logger.logError('取得統計失敗', error);
            return { total: 0, pending: 0, paid: 0, expired: 0, needReminder: 0 };
        }
    }
}

module.exports = new OrderManagerDB();
