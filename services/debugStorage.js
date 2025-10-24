// services/debugStorage.js
// 三個管理端點（需 ADMIN_TOKEN）
//   GET  /debug/write-test?token=...   → 寫入一筆測試客戶＋訂單（驗證寫入成功）
//   GET  /debug/inspect?token=...      → 檢視目前永久路徑與檔案狀態
//   POST /debug/force-backup?token=... → 立即備份 data/*.json -> backup/（時間戳）

const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

// ===== 安全驗證（必要）=====
router.use((req, res, next) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN is not set' });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ===== 共用工具 =====
const DATA_DIR = process.env.DATA_DIR_FALLBACK || path.join(__dirname, '../data');
const PERSISTENT_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'stain-bot')
  : path.join('/app', '.persist', 'stain-bot');

const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ORDERS_FILE    = path.join(DATA_DIR, 'orders.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const BACKUP_DIR     = path.join(PERSISTENT_ROOT, 'backup');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function statOrNull(p) {
  try {
    const s = fs.statSync(p);
    return { path: p, isFile: s.isFile(), size: s.size, mtime: s.mtime };
  } catch { return null; }
}
function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  ensureDir(BACKUP_DIR);
  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const dest = path.join(BACKUP_DIR, `${path.basename(file)}.${ts}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

// ===== ① 寫入測試 =====
router.get('/write-test', (req, res) => {
  try {
    const now = Date.now();
    const custId = `TEST-CUST-${now}`;
    const orderId = `TEST-ORD-${now}`;

    // customers.json：兼容物件/陣列
    let customers = readJsonSafe(CUSTOMERS_FILE);
    if (!customers) customers = {};
    if (Array.isArray(customers)) {
      customers.push({ id: custId, name: '測試客戶', createdAt: now });
    } else {
      customers[custId] = { id: custId, name: '測試客戶', createdAt: now };
    }
    writeJson(CUSTOMERS_FILE, customers);

    // orders.json：兼容物件/陣列
    let orders = readJsonSafe(ORDERS_FILE);
    if (!orders) orders = [];
    const newOrder = { orderId, userId: custId, userName: '測試客戶', amount: 1, currency: 'TWD', status: 'pending', createdAt: now };
    if (Array.isArray(orders)) orders.push(newOrder);
    else orders[orderId] = newOrder;
    writeJson(ORDERS_FILE, orders);

    return res.json({
      ok: true,
      message: '寫入測試完成（customers.json / orders.json 已更新）',
      files: { customers: statOrNull(CUSTOMERS_FILE), orders: statOrNull(ORDERS_FILE) },
      dataDir: DATA_DIR,
      persistentRoot: PERSISTENT_ROOT
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== ② 檢視現況 =====
router.get('/inspect', (req, res) => {
  try {
    const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
    return res.json({
      ok: true,
      env: {
        RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
        DATA_DIR_FALLBACK: process.env.DATA_DIR_FALLBACK || null
      },
      paths: { dataDir: DATA_DIR, persistentRoot: PERSISTENT_ROOT, backupDir: BACKUP_DIR },
      stats: {
        dataDir: statOrNull(DATA_DIR),
        persistentRoot: statOrNull(PERSISTENT_ROOT),
        backupDir: statOrNull(BACKUP_DIR),
        customers: statOrNull(CUSTOMERS_FILE),
        orders: statOrNull(ORDERS_FILE),
        templates: statOrNull(TEMPLATES_FILE)
      },
      lists: {
        persistentRoot: list(PERSISTENT_ROOT).slice(0, 50),
        backupDir: list(BACKUP_DIR).slice(0, 50)
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== ③ 立即備份 =====
router.post('/force-backup', (req, res) => {
  try {
    const results = {
      customers: backupFile(CUSTOMERS_FILE),
      orders: backupFile(ORDERS_FILE),
      templates: backupFile(TEMPLATES_FILE)
    };
    return res.json({ ok: true, backupDir: BACKUP_DIR, backup: results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
