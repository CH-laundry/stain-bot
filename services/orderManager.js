const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ORDERS_FILE = path.join(__dirname, '../data/orders.json');
const CUSTOMERS_FILE = path.join(__dirname, '../data/customers.json');
const TEMPLATES_FILE = path.join(__dirname, '../data/templates.json');
const EXPIRY_TIME = 7 * 24 * 60 * 60 * 1000; // 🔥 7 天過期 (168小時)
const FIRST_REMINDER_DELAY = 2 * 24 * 60 * 60 * 1000; // 2 天後開始提醒
const REMINDER_INTERVAL = 2 * 24 * 60 * 60 * 1000; // 每兩天提醒一次


class OrderManager {
  constructor() {
    this.orders = new Map();
    this.customers = new Map();
    this.templates = [];
    this.ensureDataDirectory();
    this.loadOrders();
    this.loadCustomers();
    this.loadTemplates();
  }

  ensureDataDirectory() {
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  // ========== 訂單管理 ==========
  loadOrders() {
    try {
      if (fs.existsSync(ORDERS_FILE)) {
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        const ordersArray = JSON.parse(data);
        ordersArray.forEach(order => {
          this.orders.set(order.orderId, order);
        });
        logger.logToFile(`✅ 載入 ${ordersArray.length} 筆訂單`);
      }
    } catch (error) {
      logger.logError('載入訂單失敗', error);
    }
  }

  saveOrders() {
    try {
      const ordersArray = Array.from(this.orders.values());
      fs.writeFileSync(ORDERS_FILE, JSON.stringify(ordersArray, null, 2), 'utf8');
    } catch (error) {
      logger.logError('儲存訂單失敗', error);
    }
  }

  createOrder(orderId, orderData) {
    const now = Date.now();
    const order = {
      orderId,
      userId: orderData.userId,
      userName: orderData.userName,
      amount: orderData.amount,
      status: 'pending',
      createdAt: now,
      expiryTime: now + EXPIRY_TIME,
      ecpayTransactionId: orderData.ecpayTransactionId || null,
      ecpayPaymentUrl: orderData.ecpayPaymentUrl || null,
      linepayTransactionId: orderData.linepayTransactionId || null,
      linepayPaymentUrl: orderData.linepayPaymentUrl || null,
      lastReminderSent: null,
      reminderCount: 0,
      retryCount: 0,
      paymentMethod: null,
      paidAt: null,
      reminderEnabled: true
    };
    this.orders.set(orderId, order);
    this.saveOrders();
    logger.logToFile(`✅ 建立訂單: ${orderId} - ${orderData.userName} - NT$ ${orderData.amount}`);
    return order;
  }

  getOrder(orderId) {
    return this.orders.get(orderId);
  }

  getAllOrders() {
    return Array.from(this.orders.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getPendingOrders() {
    return this.getAllOrders().filter(order =>
      order.status === 'pending' && !this.isExpired(order.orderId)
    );
  }

  getOrdersByStatus(status) {
    return this.getAllOrders().filter(order => order.status === status);
  }

  getOrdersNeedingReminder() {
    const now = Date.now();

    return this.getPendingOrders().filter(order => {
      if (!order.reminderEnabled) {
        return false;
      }

      const timeSinceCreation = now - order.createdAt;

      // 🔥 建立後 5 分鐘才開始提醒
      if (timeSinceCreation < FIRST_REMINDER_DELAY) {
        return false;
      }

      // 🔥 如果從未提醒過，立即提醒
      if (!order.lastReminderSent) {
        return true;
      }

      // 🔥 距離上次提醒超過 2 分鐘，再次提醒
      const timeSinceLastReminder = now - order.lastReminderSent;
      return timeSinceLastReminder >= REMINDER_INTERVAL;
    });
  }

  updatePaymentInfo(orderId, paymentData) {
    const order = this.orders.get(orderId);
    if (order) {
      if (paymentData.ecpayTransactionId) {
        order.ecpayTransactionId = paymentData.ecpayTransactionId;
        order.ecpayPaymentUrl = paymentData.ecpayPaymentUrl;
      }
      if (paymentData.linepayTransactionId) {
        order.linepayTransactionId = paymentData.linepayTransactionId;
        order.linepayPaymentUrl = paymentData.linepayPaymentUrl;
      }
      order.retryCount++;
      this.saveOrders();
      logger.logToFile(`✅ 更新訂單付款資訊: ${orderId}`);
    }
  }

  updateOrderStatus(orderId, status, paymentMethod = null) {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = status;
      if (status === 'paid') {
        order.paidAt = Date.now();
        order.paymentMethod = paymentMethod;
        order.reminderEnabled = false;
      }
      this.saveOrders();
      logger.logToFile(`✅ 更新訂單狀態: ${orderId} -> ${status} (${paymentMethod || '未知'})`);
    }
  }

  updateOrderStatusByUserId(userId, status, paymentMethod = null) {
    let updated = 0;
    for (const [orderId, order] of this.orders.entries()) {
      if (order.userId === userId && order.status === 'pending') {
        order.status = status;
        if (status === 'paid') {
          order.paidAt = Date.now();
          order.paymentMethod = paymentMethod;
          order.reminderEnabled = false;
        }
        updated++;
        logger.logToFile(`✅ 更新訂單狀態 (通過 userId): ${orderId} -> ${status} (${paymentMethod || '未知'})`);
      }
    }
    if (updated > 0) {
      this.saveOrders();
    }
    return updated;
  }

  markReminderSent(orderId) {
    const order = this.orders.get(orderId);
    if (order) {
      order.lastReminderSent = Date.now();
      order.reminderCount = (order.reminderCount || 0) + 1;
      this.saveOrders();
      logger.logToFile(`✅ 標記提醒已發送: ${orderId} (第 ${order.reminderCount} 次)`);
    }
  }

  toggleReminder(orderId, enabled) {
    const order = this.orders.get(orderId);
    if (order) {
      order.reminderEnabled = enabled;
      this.saveOrders();
      logger.logToFile(`${enabled ? '✅ 啟用' : '⏸️ 暫停'} 提醒: ${orderId}`);
    }
  }

  isExpired(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return true;
    return Date.now() > order.expiryTime;
  }

  deleteOrder(orderId) {
    const deleted = this.orders.delete(orderId);
    if (deleted) {
      this.saveOrders();
      logger.logToFile(`🗑️ 刪除訂單: ${orderId}`);
    }
    return deleted;
  }

  cleanExpiredOrders() {
    const now = Date.now();
    let cleaned = 0;

    for (const [orderId, order] of this.orders.entries()) {
      if (order.status === 'pending' && now > order.expiryTime) {
        this.orders.delete(orderId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.saveOrders();
      logger.logToFile(`🧹 清理 ${cleaned} 筆過期訂單`);
    }

    return cleaned;
  }

  renewOrder(orderId) {
    const order = this.orders.get(orderId);
    if (order) {
      const now = Date.now();
      order.expiryTime = now + EXPIRY_TIME;
      order.status = 'pending';
      order.retryCount = 0;
      order.lastReminderSent = null;
      order.reminderCount = 0;
      order.reminderEnabled = true;
      this.saveOrders();
      logger.logToFile(`🔄 續約訂單: ${orderId} (新過期時間: 7天後)`);
      return order;
    }
    return null;
  }

  getOrderByUserIdAndAmount(userId, amount) {
    for (const [, order] of this.orders.entries()) {
      if (order.userId === userId && order.amount === amount && order.status === 'pending') {
        return order;
      }
    }
    return null;
  }

  getStatistics() {
    const all = this.getAllOrders();
    const paidOrders = all.filter(o => o.status === 'paid');
    const today = new Date().setHours(0, 0, 0, 0);
    const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const thisYear = new Date(new Date().getFullYear(), 0, 1).getTime();

    return {
      total: all.length,
      pending: all.filter(o => o.status === 'pending' && !this.isExpired(o.orderId)).length,
      paid: paidOrders.length,
      expired: all.filter(o => o.status === 'pending' && this.isExpired(o.orderId)).length,
      needReminder: this.getOrdersNeedingReminder().length,
      revenue: {
        today: paidOrders.filter(o => o.paidAt >= today).reduce((sum, o) => sum + o.amount, 0),
        month: paidOrders.filter(o => o.paidAt >= thisMonth).reduce((sum, o) => sum + o.amount, 0),
        year: paidOrders.filter(o => o.paidAt >= thisYear).reduce((sum, o) => sum + o.amount, 0),
        total: paidOrders.reduce((sum, o) => sum + o.amount, 0)
      }
    };
  }

  // ========== 客戶編號管理 ==========
  loadCustomers() {
    try {
      if (fs.existsSync(CUSTOMERS_FILE)) {
        const data = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
        const customersArray = JSON.parse(data);
        customersArray.forEach(customer => {
          this.customers.set(customer.number, customer);
        });
        logger.logToFile(`✅ 載入 ${customersArray.length} 筆客戶編號`);
      }
    } catch (error) {
      logger.logError('載入客戶編號失敗', error);
    }
  }

  saveCustomers() {
    try {
      const customersArray = Array.from(this.customers.values());
      fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customersArray, null, 2), 'utf8');
    } catch (error) {
      logger.logError('儲存客戶編號失敗', error);
    }
  }

  saveCustomerNumber(number, name, userId) {
    const customer = {
      number: number,
      name: name,
      userId: userId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.customers.set(number, customer);
    this.saveCustomers();
    logger.logToFile(`✅ 儲存客戶編號: #${number} - ${name}`);
    return customer;
  }

  getCustomerByNumber(number) {
    return this.customers.get(number);
  }

  getAllCustomerNumbers() {
    return Array.from(this.customers.values());
  }

  searchCustomerNumber(query) {
    const customers = this.getAllCustomerNumbers();
    return customers.filter(c =>
      String(c.number).includes(query) ||
      (c.name && c.name.includes(query)) ||
      (c.userId && c.userId.includes(query))
    );
  }

  deleteCustomerNumber(number) {
    const deleted = this.customers.delete(number);
    if (deleted) {
      this.saveCustomers();
      logger.logToFile(`🗑️ 刪除客戶編號: #${number}`);
    }
    return deleted;
  }

  // ========== 訊息模板管理 ==========
  loadTemplates() {
    try {
      if (fs.existsSync(TEMPLATES_FILE)) {
        const data = fs.readFileSync(TEMPLATES_FILE, 'utf8');
        this.templates = JSON.parse(data);
        logger.logToFile(`✅ 載入 ${this.templates.length} 個訊息模板`);
      } else {
        this.templates = [
          '您好,已收回衣物,金額 NT$ {amount},請儘速付款,謝謝!',
          '您的衣物已清洗完成,金額 NT$ {amount},可付款取件',
          '衣物處理中,預付金額 NT$ {amount}',
          '訂金收訖 NT$ {amount},感謝您的支持!',
          '⏰ 付款提醒:您有一筆 NT$ {amount} 的訂單尚未付款,請儘速完成付款!'
        ];
        this.saveTemplates();
      }
    } catch (error) {
      logger.logError('載入訊息模板失敗', error);
    }
  }

  saveTemplates() {
    try {
      fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(this.templates, null, 2), 'utf8');
    } catch (error) {
      logger.logError('儲存訊息模板失敗', error);
    }
  }

  getAllTemplates() {
    return this.templates;
  }

  addTemplate(content) {
    this.templates.push(content);
    this.saveTemplates();
    logger.logToFile(`✅ 新增訊息模板`);
    return true;
  }

  updateTemplate(index, content) {
    if (index >= 0 && index < this.templates.length) {
      this.templates[index] = content;
      this.saveTemplates();
      logger.logToFile(`✅ 更新訊息模板 #${index}`);
      return true;
    }
    return false;
  }

  deleteTemplate(index) {
    if (index >= 0 && index < this.templates.length) {
      this.templates.splice(index, 1);
      this.saveTemplates();
      logger.logToFile(`🗑️ 刪除訊息模板 #${index}`);
      return true;
    }
    return false;
  }
}

module.exports = new OrderManager();
