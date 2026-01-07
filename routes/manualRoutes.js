// routes/manualRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'manual.json');

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
  return 'MAN' + Date.now().toString(36).toUpperCase() + '-' + 
         Math.random().toString(36).substring(2, 6).toUpperCase();
}

// GET - 取得所有人工通知
router.get('/orders', (req, res) => {
  try {
    const data = loadData();
    res.json({ success: true, orders: data.orders });
  } catch (e) {
    console.error('載入人工通知失敗', e);
    res.json({ success: false, error: e.message || '載入失敗' });
  }
});

// POST - 新增人工通知
router.post('/add', (req, res) => {
  try {
    const {
      customerNumber,
      customerName,
      needDelivery = 'no',
      content = '',
      amount = 0  // ⭐ 新增金額欄位
    } = req.body || {};

    if (!customerNumber || !customerName) {
      return res.json({ success: false, error: '缺少必填欄位（編號 / 姓名）' });
    }

    const data = loadData();
    const order = {
      id: generateId(),
      customerNumber: String(customerNumber),
      customerName: String(customerName),
      needDelivery: needDelivery === 'yes' ? 'yes' : 'no',
      content: String(content || ''),
      amount: parseInt(amount) || 0,  // ⭐ 新增金額
      paid: false,  // ⭐ 新增付款狀態
      createdDate: new Date().toISOString(),
      notified: false
    };

    data.orders.unshift(order);
    saveData(data);

    res.json({ success: true, order });
  } catch (e) {
    console.error('新增人工通知失敗', e);
    res.json({ success: false, error: e.message || '新增失敗' });
  }
});

// ⭐⭐⭐ 新增：標記已付款 API ⭐⭐⭐
router.post('/mark-paid', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    data.orders[idx].paid = true;
    data.orders[idx].paidDate = new Date().toISOString();
    saveData(data);

    res.json({ success: true });
  } catch (e) {
    console.error('標記已付款失敗', e);
    res.json({ success: false, error: e.message || '操作失敗' });
  }
});
// ⭐⭐⭐ 新增 API 結束 ⭐⭐⭐

// POST - 標記已通知
router.post('/mark-notified', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    data.orders[idx].notified = true;
    data.orders[idx].notifiedDate = new Date().toISOString();
    saveData(data);

    res.json({ success: true });
  } catch (e) {
    console.error('標記已通知失敗', e);
    res.json({ success: false, error: e.message || '操作失敗' });
  }
});

// POST - 更新人工通知
router.post('/update', (req, res) => {
  try {
    const { id, needDelivery, content, amount } = req.body || {};  // ⭐ 新增 amount
    if (!id) return res.json({ success: false, error: '缺少 id' });

    const data = loadData();
    const idx = data.orders.findIndex(o => o.id === id);
    if (idx === -1) {
      return res.json({ success: false, error: '找不到此紀錄' });
    }

    const target = data.orders[idx];
    if (needDelivery === 'yes' || needDelivery === 'no') {
      target.needDelivery = needDelivery;
    }
    if (typeof content === 'string') {
      target.content = content;
    }
    if (amount !== undefined) {  // ⭐ 新增金額更新
      target.amount = parseInt(amount) || 0;
    }

    saveData(data);
    res.json({ success: true });
  } catch (e) {
    console.error('更新人工通知失敗', e);
    res.json({ success: false, error: e.message || '更新失敗' });
  }
});

// DELETE - 刪除人工通知
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
    console.error('刪除人工通知失敗', e);
    res.json({ success: false, error: e.message || '刪除失敗' });
  }
});

module.exports = router;
