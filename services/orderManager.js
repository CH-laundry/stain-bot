// services/orderManagerDB.js
const { pool } = require('./database');
const logger = require('./logger');

/** 工具：將 Date.now() 以 ms 傳入，回傳是否過期（expiry_time 也是 ms） */
function isExpired(expiryTimeMs) {
  return typeof expiryTimeMs === 'number' && Date.now() > expiryTimeMs;
}

/** 建議：啟動時先呼叫，確保索引存在（CREATE IF NOT EXISTS 不支援，用 DO blocks 或 try/catch 忽略重複） */
async function ensureIndexes() {
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_expiry_time ON orders(expiry_time);`);
  } catch (err) {
    // 舊版 PG 可能不支援 IF NOT EXISTS，重複建立報錯可忽略
    if (String(err.message).includes('already exists')) return;
    logger.logError('建立索引失敗', err);
  }
}

/** 新增訂單（若 order_id 已存在會報錯） */
async function createOrder({
  order_id,
  user_id,
  user_name,
  amount,
  status = 'pending',
  created_at = Date.now(),
  expiry_time,               // 建議：現在時間 + 20 * 60 * 1000（或你自訂）
  transaction_id = null,
  payment_url = null,
  last_reminder_sent = null,
  retry_count = 0,
  payment_method = null,
  paid_at = null
}) {
  const sql = `
    INSERT INTO orders (
      order_id, user_id, user_name, amount, status, created_at, expiry_time,
      transaction_id, payment_url, last_reminder_sent, retry_count, payment_method, paid_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *;
  `;
  const params = [
    order_id, user_id, user_name, amount, status, created_at, expiry_time,
    transaction_id, payment_url, last_reminder_sent, retry_count, payment_method, paid_at
  ];
  const { rows } = await pool.query(sql, params);
  logger.logToFile(`✅ 建立訂單成功 ${order_id}（user:${user_id}, amount:${amount}）`);
  return rows[0];
}

/** 以 order_id 取得訂單 */
async function getOrderById(order_id) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE order_id = $1 LIMIT 1;`, [order_id]);
  return rows[0] || null;
}

/** 以 transaction_id 取得訂單（例如金流回調用） */
async function getOrderByTransactionId(transaction_id) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE transaction_id = $1 LIMIT 1;`, [transaction_id]);
  return rows[0] || null;
}

/** 更新狀態 */
async function updateOrderStatus(order_id, status) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = $2 WHERE order_id = $1 RETURNING *;`,
    [order_id, status]
  );
  logger.logToFile(`🔁 訂單 ${order_id} 狀態改為 ${status}`);
  return rows[0] || null;
}

/** 設定付款網址與金流交易編號（建立付款連結後呼叫） */
async function setPaymentLink(order_id, { payment_url, transaction_id }) {
  const { rows } = await pool.query(
    `UPDATE orders
     SET payment_url = $2, transaction_id = $3
     WHERE order_id = $1
     RETURNING *;`,
    [order_id, payment_url || null, transaction_id || null]
  );
  logger.logToFile(`🔗 訂單 ${order_id} 設定 payment_url/transaction_id`);
  return rows[0] || null;
}

/** 標記為已付款 */
async function markAsPaid(order_id, { paid_at = Date.now(), payment_method = null, transaction_id = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE orders
     SET status = 'paid',
         paid_at = $2,
         payment_method = COALESCE($3, payment_method),
         transaction_id = COALESCE($4, transaction_id)
     WHERE order_id = $1
     RETURNING *;`,
    [order_id, paid_at, payment_method, transaction_id]
  );
  logger.logToFile(`💰 訂單 ${order_id} 已付款`);
  return rows[0] || null;
}

/** 取消訂單（例如付款逾時或用戶取消） */
async function cancelOrder(order_id, reason = 'canceled') {
  const { rows } = await pool.query(
    `UPDATE orders SET status = $2 WHERE order_id = $1 RETURNING *;`,
    [order_id, reason]
  );
  logger.logToFile(`🛑 訂單 ${order_id} 已取消（${reason}）`);
  return rows[0] || null;
}

/** 設定最後提醒時間（ms） */
async function setLastReminderSent(order_id, tsMs = Date.now()) {
  const { rows } = await pool.query(
    `UPDATE orders SET last_reminder_sent = $2 WHERE order_id = $1 RETURNING *;`,
    [order_id, tsMs]
  );
  return rows[0] || null;
}

/** 增加重試次數（用於重新送連結/重試拉金流） */
async function incrementRetryCount(order_id) {
  const { rows } = await pool.query(
    `UPDATE orders SET retry_count = COALESCE(retry_count,0) + 1 WHERE order_id = $1 RETURNING *;`,
    [order_id]
  );
  return rows[0] || null;
}

/** 列出尚未付款且已過期的訂單（批次處理逾時取消/提醒） */
async function listExpiredUnpaid(nowMs = Date.now()) {
  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE status = 'pending'
       AND expiry_time <= $1
     ORDER BY created_at ASC
     LIMIT 200;`,
    [nowMs]
  );
  return rows;
}

/** 依 user 查詢最近 N 筆（預設 20） */
async function listOrdersByUser(user_id, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2;`,
    [user_id, limit]
  );
  return rows;
}

/** 刪除訂單（謹慎使用） */
async function deleteOrder(order_id) {
  await pool.query(`DELETE FROM orders WHERE order_id = $1;`, [order_id]);
  logger.logToFile(`🧹 刪除訂單 ${order_id}`);
  return true;
}

/** 便捷：建立或覆蓋（有就更新，無就新建） */
async function upsertOrder(order) {
  const sql = `
    INSERT INTO orders (
      order_id, user_id, user_name, amount, status, created_at, expiry_time,
      transaction_id, payment_url, last_reminder_sent, retry_count, payment_method, paid_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (order_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      user_name = EXCLUDED.user_name,
      amount = EXCLUDED.amount,
      status = EXCLUDED.status,
      created_at = EXCLUDED.created_at,
      expiry_time = EXCLUDED.expiry_time,
      transaction_id = EXCLUDED.transaction_id,
      payment_url = EXCLUDED.payment_url,
      last_reminder_sent = EXCLUDED.last_reminder_sent,
      retry_count = EXCLUDED.retry_count,
      payment_method = EXCLUDED.payment_method,
      paid_at = EXCLUDED.paid_at
    RETURNING *;
  `;
  const params = [
    order.order_id, order.user_id, order.user_name, order.amount, order.status ?? 'pending',
    order.created_at ?? Date.now(), order.expiry_time,
    order.transaction_id ?? null, order.payment_url ?? null,
    order.last_reminder_sent ?? null, order.retry_count ?? 0,
    order.payment_method ?? null, order.paid_at ?? null
  ];
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

module.exports = {
  // helpers
  isExpired, ensureIndexes,
  // CRUD
  createOrder, getOrderById, getOrderByTransactionId, updateOrderStatus,
  setPaymentLink, markAsPaid, cancelOrder,
  setLastReminderSent, incrementRetryCount,
  listExpiredUnpaid, listOrdersByUser,
  deleteOrder, upsertOrder
};
