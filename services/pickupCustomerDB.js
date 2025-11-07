// services/pickupCustomerDB.js
// 統一客戶資料庫管理（整合付款和取件追蹤）

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CUSTOMERS_FILE = '/data/customers.json';

// 確保檔案存在
function ensureCustomersFile() {
  const dir = path.dirname(CUSTOMERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(CUSTOMERS_FILE)) {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

// 讀取客戶資料
function readCustomers() {
  ensureCustomersFile();
  try {
    const data = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.logError('讀取客戶資料失敗', error);
    return {};
  }
}

// 寫入客戶資料
function writeCustomers(customers) {
  try {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2), 'utf8');
  } catch (error) {
    logger.logError('寫入客戶資料失敗', error);
  }
}

// 儲存/更新客戶
function saveCustomer(data) {
  const { userId, name, number, softwareNumber } = data;
  
  if (!userId || !name) {
    throw new Error('userId 和 name 是必填欄位');
  }

  const customers = readCustomers();
  const timestamp = new Date().toISOString();

  // 尋找現有客戶（用 userId 或 number）
  let existingNumber = null;
  
  // 先找有沒有相同 userId 的客戶
  for (const [num, customer] of Object.entries(customers)) {
    if (customer.userId === userId) {
      existingNumber = num;
      break;
    }
  }

  if (existingNumber) {
    // 更新現有客戶
    customers[existingNumber] = {
      ...customers[existingNumber],
      name: name,
      userId: userId,
      softwareNumber: softwareNumber || customers[existingNumber].softwareNumber,
      updatedAt: timestamp
    };
    logger.logToFile(`♻️ 更新客戶：${existingNumber} - ${name}`);
  } else {
    // 新增客戶
    const newNumber = number || generateNextNumber(customers);
    customers[newNumber] = {
      number: newNumber,
      name: name,
      userId: userId,
      softwareNumber: softwareNumber || null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    logger.logToFile(`➕ 新增客戶：${newNumber} - ${name}`);
  }

  writeCustomers(customers);
  return customers[existingNumber || number || generateNextNumber(customers)];
}

// 自動產生下一個編號
function generateNextNumber(customers) {
  const numbers = Object.keys(customers).map(n => parseInt(n)).filter(n => !isNaN(n));
  if (numbers.length === 0) return '001';
  const maxNumber = Math.max(...numbers);
  return String(maxNumber + 1).padStart(3, '0');
}

// 查詢客戶（用編號或姓名）
function searchCustomer(keyword) {
  const customers = readCustomers();
  const results = [];

  for (const [number, customer] of Object.entries(customers)) {
    if (
      number === keyword ||
      (customer.name && customer.name.includes(keyword)) ||
      (customer.softwareNumber && customer.softwareNumber === keyword)
    ) {
      results.push({ number, ...customer });
    }
  }

  return results;
}

// 取得客戶（用編號）
function getCustomer(number) {
  const customers = readCustomers();
  return customers[number] || null;
}

// 取得所有客戶
function getAllCustomers() {
  const customers = readCustomers();
  return Object.entries(customers).map(([number, data]) => ({
    number,
    ...data
  }));
}

// 刪除客戶
function deleteCustomer(number) {
  const customers = readCustomers();
  if (!customers[number]) return false;
  
  delete customers[number];
  writeCustomers(customers);
  logger.logToFile(`🗑️ 刪除客戶：${number}`);
  return true;
}

// 從舊的 users.json 匯入
function importFromUsersJson() {
  const USERS_FILE = '/data/users.json';
  if (!fs.existsSync(USERS_FILE)) return;

  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    const users = JSON.parse(data);
    
    if (!Array.isArray(users)) return;

    const customers = readCustomers();
    let imported = 0;

    for (const user of users) {
      if (!user.userId || !user.name) continue;

      // 檢查是否已存在
      const exists = Object.values(customers).some(c => c.userId === user.userId);
      if (exists) continue;

      // 新增
      const newNumber = generateNextNumber(customers);
      customers[newNumber] = {
        number: newNumber,
        name: user.name,
        userId: user.userId,
        createdAt: user.createdAt || new Date().toISOString(),
        updatedAt: user.lastUpdate || new Date().toISOString()
      };
      imported++;
    }

    if (imported > 0) {
      writeCustomers(customers);
      logger.logToFile(`📥 從 users.json 匯入 ${imported} 筆客戶資料`);
    }
  } catch (error) {
    logger.logError('匯入 users.json 失敗', error);
  }
}

module.exports = {
  saveCustomer,
  searchCustomer,
  getCustomer,
  getAllCustomers,
  deleteCustomer,
  importFromUsersJson
};
