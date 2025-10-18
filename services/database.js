const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                order_id VARCHAR(50) PRIMARY KEY,
                user_id VARCHAR(100) NOT NULL,
                user_name VARCHAR(100) NOT NULL,
                amount INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at BIGINT NOT NULL,
                expiry_time BIGINT NOT NULL,
                transaction_id VARCHAR(100),
                payment_url TEXT,
                last_reminder_sent BIGINT,
                retry_count INTEGER DEFAULT 0,
                payment_method VARCHAR(50),
                paid_at BIGINT
            );
            CREATE INDEX IF NOT EXISTS idx_user_id ON orders(user_id);
            CREATE INDEX IF NOT EXISTS idx_status ON orders(status);
            CREATE INDEX IF NOT EXISTS idx_created_at ON orders(created_at);
        `);
        logger.logToFile('✅ 資料庫初始化成功');
        console.log('✅ 資料庫初始化成功');
    } catch (error) {
        logger.logError('資料庫初始化失敗', error);
        console.error('❌ 資料庫初始化失敗:', error);
        throw error;
    }
}

module.exports = { pool, initDatabase };
