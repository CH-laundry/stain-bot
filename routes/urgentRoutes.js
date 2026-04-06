// routes/urgentRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'urgent.json');

// 確保檔案存在
function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({ orders: [] }, null, 2), 'utf8');
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

function generateId() {
  return 'URG' + Date.now().toString(36).toUpperCase() + '-' + 
         Math.random().toString(36).substring(2, 6).toUpperCase();
}

// GET - 取得所有急件
router.get('/orders', (req, res) => {
  try {
    const data = loadData();
    res.json({ success: true, orders: data.orders });
  } catch (e) {
    console.error('載入急件失敗', e);
    res.json({ success: false, error: e.message || '載入失敗' });
  }
});

// POST - 新增急件
router.post('/add', (req, res) => {
  try {
    const {
      customerNumber,
      customerName,
      clothesRange,
      trackDate,
      pickupDate,
      note = ''
    } = req.body || {};

    if (!customerNumber || !customerName || !clothesRange || !trackDate || !pickupDate) {
      return res.json({ success: false, error: '缺少必填欄位' });
    }

    const data = loadData();
    const order = {
      id: generateId(),
      customerNumber: String(customerNumber),
      customerName: String(customerName),
      clothesRange: String(clothesRange),
      trackDate: trackDate,
      pickupDate: pickupDate,
      note: String(note || ''),
      createdDate: new Date().toISOString(),
      completed: false
    };

    data.orders.unshift(order);
    saveData(data);

    res.json({ success: true, order });
  } catch (e) {
    console.error('新增急件失敗', e);
    res.json({ success: false, error: e.message || '新增失敗' });
  }
});

// POST - 標記完成
router.post('/complete', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此急件' });
    }

    data.orders[idx].completed = true;
    data.orders[idx].completedDate = new Date().toISOString();
    saveData(data);

    res.json({ success: true });
  } catch (e) {
    console.error('標記完成失敗', e);
    res.json({ success: false, error: e.message || '操作失敗' });
  }
});

// POST - 更新急件
router.post('/update', (req, res) => {
  try {
    const { id, clothesRange, trackDate, pickupDate, note } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此急件' });
    }

    const target = data.orders[idx];
    if (clothesRange) target.clothesRange = clothesRange;
    if (trackDate) target.trackDate = trackDate;
    if (pickupDate) target.pickupDate = pickupDate;
    if (typeof note === 'string') target.note = note;

    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('更新急件失敗', e);
    res.json({ success: false, error: e.message || '更新失敗' });
  }
});

// DELETE - 刪除急件
router.delete('/order/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const lenBefore = data.orders.length;
    data.orders = data.orders.filter(o => o.id !== id);

    if (data.orders.length === lenBefore) {
      return res.json({ success: false, error: '找不到此急件' });
    }

    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('刪除急件失敗', e);
    res.json({ success: false, error: e.message || '刪除失敗' });
  }
});

module.exports = router;
