const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/pickup-tracking.json');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadOrders() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[PICKUP DB] 載入失敗:', error.message);
  }
  return [];
}

function saveOrders(orders) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('[PICKUP DB] 儲存失敗:', error.message);
    return false;
  }
}

function addOrder(customerNumber, customerName, userID) {
  const orders = loadOrders();
  const existing = orders.find(o => o.customerNumber === customerNumber);
  if (existing) {
    return { success: false, message: '此客戶編號已在追蹤中' };
  }

  const newOrder = {
    customerNumber,
    customerName,
    userID,
    notifiedAt: new Date().toISOString(),
    reminderSent: false,
    reminderCount: 0,
    reminderHistory: [],
    pickedUp: false,
    note: '',
    createdAt: new Date().toISOString()
  };

  orders.push(newOrder);
  saveOrders(orders);
  return { success: true, order: newOrder };
}

function getAllOrders() {
  return loadOrders();
}

function updateOrder(customerNumber, updates) {
  const orders = loadOrders();
  const index = orders.findIndex(o => o.customerNumber === customerNumber);
  
  if (index === -1) {
    return { success: false, message: '找不到此訂單' };
  }

  orders[index] = { ...orders[index], ...updates };
  saveOrders(orders);
  return { success: true, order: orders[index] };
}

function markAsPickedUp(customerNumber) {
  return updateOrder(customerNumber, {
    pickedUp: true,
    pickedUpAt: new Date().toISOString()
  });
}

function updateNote(customerNumber, note) {
  return updateOrder(customerNumber, { note: note });
}

function deleteOrder(customerNumber) {
  const orders = loadOrders();
  const filtered = orders.filter(o => o.customerNumber !== customerNumber);
  
  if (orders.length === filtered.length) {
    return { success: false, message: '找不到此訂單' };
  }

  saveOrders(filtered);
  return { success: true };
}

module.exports = {
  addOrder,
  getAllOrders,
  updateOrder,
  markAsPickedUp,
  updateNote,
  deleteOrder
};
