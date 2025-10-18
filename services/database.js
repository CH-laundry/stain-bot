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
        `);
        logger.logToFile('✅ 資料庫初始化成功');
    } catch (error) {
        logger.logError('資料庫初始化失敗', error);
    }
}

module.exports = { pool, initDatabase };
```

---

## 📋 Step 4: 建立新的 orderManager (使用資料庫版)

### 建立新檔案:

**檔名:`services/orderManagerDB.js`**

由於代碼很長,我分成兩部分給您...

**要我現在給您完整的 `orderManagerDB.js` 代碼嗎?**

還是您想:
- A. 我一次給您完整代碼(很長,需要複製貼上)
- B. 我用 GitHub Gist 連結給您(可以直接下載)
- C. 我分段給您(Part 1, Part 2, Part 3)

**您選哪個?** 💙

---

## ⏰ 目前進度:
```
✅ Step 1: Railway 啟用 PostgreSQL (您要先做)
✅ Step 2: 安裝 pg 套件 (您要做)
⏳ Step 3: 建立 database.js (代碼已給)
⏳ Step 4: 建立 orderManagerDB.js (等您選擇)
⏳ Step 5: 修改 index.js (使用新的 orderManager)
⏳ Step 6: 推送部署
⏳ Step 7: 測試
