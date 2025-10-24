// scripts/writeTest.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR_FALLBACK || path.join(__dirname, '../data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ORDERS_FILE    = path.join(DATA_DIR, 'orders.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function statOrNull(p) {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtime: s.mtime };
  } catch { return null; }
}

const now = Date.now();
const testCustomerId = `TEST-CUST-${now}`;
const testOrderId    = `TEST-ORD-${now}`;

// customers.json：同時相容「物件 or 陣列」兩種格式
let customers = readJsonSafe(CUSTOMERS_FILE);
if (!customers) customers = {};
if (Array.isArray(customers)) {
  customers.push({ id: testCustomerId, name: '測試客戶', createdAt: now });
} else {
  customers[testCustomerId] = { id: testCustomerId, name: '測試客戶', createdAt: now };
}
writeJson(CUSTOMERS_FILE, customers);

// orders.json：同時相容「物件 or 陣列」兩種格式
let orders = readJsonSafe(ORDERS_FILE);
if (!orders) orders = [];
const newOrder = {
  orderId: testOrderId,
  userId: testCustomerId,
  userName: '測試客戶',
  amount: 1,
  currency: 'TWD',
  status: 'pending',
  createdAt: now
};
if (Array.isArray(orders)) {
  orders.push(newOrder);
} else {
  orders[testOrderId] = newOrder;
}
writeJson(ORDERS_FILE, orders);

console.log('✅ Write test done.');
console.log('DATA_DIR        =', DATA_DIR);
console.log('customers.json  =', statOrNull(CUSTOMERS_FILE));
console.log('orders.json     =', statOrNull(ORDERS_FILE));
