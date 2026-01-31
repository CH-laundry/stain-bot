// routes/deliveryRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// 資料檔案路徑：project-root/data/delivery.json
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'delivery.json');

// 確保資料夾 & 檔案存在
function ensureFile() {
  // 建資料夾
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 如果檔案不存在就初始化一份
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(
      FILE_PATH,
      JSON.stringify({ orders: [] }, null, 2),
      'utf8'
    );
  }
}


function loadData() {
  ensureFile();
  const raw = fs.readFileSync(FILE_PATH, 'utf8') || '{"orders":[]}';
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.orders)) data.orders = [];
    return data;
  } catch (e) {
    return { orders: [] };
  }
}

function saveData(data) {
  ensureFile();
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// 產生唯一 ID
function generateId() {
  return (
    'DEL' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    Math.random().toString(36).substring(2, 6).toUpperCase()
  );
}

/**
 * GET /api/delivery/orders
 * 取得所有外送紀錄
 */
router.get('/orders', (req, res) => {
  try {
    const data = loadData();
// ⭐ 新增：過濾掉壞掉的資料
    const validOrders = (data.orders || []).filter(order => {
      return order && 
             typeof order === 'object' && 
             order.id &&
             order.customerNumber && 
             order.customerName;
    });
    
    console.log(`✅ 載入外送紀錄成功: ${validOrders.length} 筆`);
    
    res.json({ success: true, orders: data.orders });
  } catch (e) {
    console.error('載入外送紀錄失敗', e);
    res.json({ success: false, error: e.message || '載入失敗' });
  }
});

/**
 * POST /api/delivery/add
 * 新增外送紀錄
 * body: { customerNumber, customerName, amount, notifyStatus, note, scheduledDate }
 */
router.post('/add', (req, res) => {
  try {
    const {
      customerNumber,
      customerName,
      amount,
      notifyStatus = 'not_sent',
      note = '',
      scheduledDate = null
    } = req.body || {};

    if (!customerNumber || !customerName || amount == null) {
      return res.json({ success: false, error: '缺少必填欄位（編號 / 姓名 / 金額）' });
    }

    const amt = parseInt(amount, 10);
    if (Number.isNaN(amt) || amt < 0) {
      return res.json({ success: false, error: '金額格式不正確' });
    }

    const data = loadData();

    const order = {
      id: generateId(),
      customerNumber: String(customerNumber),
      customerName: String(customerName),
      amount: amt,
      notifyStatus: notifyStatus === 'sent' ? 'sent' : 'not_sent',
      note: String(note || ''),
      createdDate: new Date().toISOString(),
      scheduledDate: scheduledDate || null, // YYYY-MM-DD
      signed: false
    };

    // 最新的放最前面
    data.orders.unshift(order);
    saveData(data);

    res.json({ success: true, order });
  } catch (e) {
    console.error('新增外送紀錄失敗', e);
    res.json({ success: false, error: e.message || '新增失敗' });
  }
});

/**
 * POST /api/delivery/mark-signed
 * body: { id }
 */
router.post('/mark-signed', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    data.orders[idx].signed = true;
    saveData(data);

    res.json({ success: true });
  } catch (e) {
    console.error('標記簽收失敗', e);
    res.json({ success: false, error: e.message || '更新失敗' });
  }
});

/**
 * POST /api/delivery/update
 * body: { id, amount, note, notifyStatus, scheduledDate }
 */
router.post('/update', (req, res) => {
  try {
    const { id, amount, note, notifyStatus, scheduledDate } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    const target = data.orders[idx];

    if (amount != null) {
      const amt = parseInt(amount, 10);
      if (Number.isNaN(amt) || amt < 0) {
        return res.json({ success: false, error: '金額格式不正確' });
      }
      target.amount = amt;
    }

    if (typeof note === 'string') {
      target.note = note;
    }

    if (notifyStatus === 'sent' || notifyStatus === 'not_sent') {
      target.notifyStatus = notifyStatus;
    }

    if (scheduledDate === null || typeof scheduledDate === 'string') {
      target.scheduledDate = scheduledDate || null;
    }

    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('更新外送紀錄失敗', e);
    res.json({ success: false, error: e.message || '更新失敗' });
  }
});

/**
 * DELETE /api/delivery/order/:id
 */
router.delete('/order/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const lenBefore = data.orders.length;
    data.orders = data.orders.filter(o => o.id !== id);

    if (data.orders.length === lenBefore) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('刪除外送紀錄失敗', e);
    res.json({ success: false, error: e.message || '刪除失敗' });
  }
});

module.exports = router;
