// services/customerStorage.js
const fs = require('fs');
const path = require('path');

const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const FILE_PATH = path.join(VOLUME_PATH, 'customers.json');

// 初始化檔案（如果不存在）
if (!fs.existsSync(VOLUME_PATH)) {
  fs.mkdirSync(VOLUME_PATH, { recursive: true });
}
if (!fs.existsSync(FILE_PATH)) {
  fs.writeFileSync(FILE_PATH, JSON.stringify([]));
}

function loadCustomers() {
  try {
    const data = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('讀取 customers.json 失敗:', err);
    return [];
  }
}

function saveCustomers(customers) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(customers, null, 2));
    console.log('customers.json 已儲存到 Volume');
  } catch (err) {
    console.error('儲存 customers.json 失敗:', err);
  }
}

function getAllCustomers() {
  return loadCustomers();
}

function getCustomer(userId) {
  const customers = loadCustomers();
  return customers.find(c => c.userId === userId);
}

function addOrUpdateCustomer(userId, userName) {
  const customers = loadCustomers();
  const existing = customers.find(c => c.userId === userId);
  if (existing) {
    existing.userName = userName;
  } else {
    customers.push({ userId, userName });
  }
  saveCustomers(customers);
  return { userId, userName };
}

function searchCustomers(name) {
  const customers = loadCustomers();
  return customers.filter(c => c.userName.toLowerCase().includes(name.toLowerCase()));
}

module.exports = {
  getAllCustomers,
  getCustomer,
  addOrUpdateCustomer,
  searchCustomers
};
