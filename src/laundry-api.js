const fetch = require('node-fetch');
const https = require('https');
const http = require('http');

/**
 * C.H 洗衣系統 API 客戶端
 */
class LaundryAPI {
  constructor(baseUrl, authToken) {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
  }

  /**
   * 通用 API 請求方法
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.authToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...options.headers
    };

    // 建立 agent（處理 HTTP/HTTPS 連線）
    const agent = url.startsWith('https') 
      ? new https.Agent({ 
          rejectUnauthorized: false,
          keepAlive: true,
          timeout: 30000
        })
      : new http.Agent({ 
          keepAlive: true,
          timeout: 30000
        });

    try {
      console.log(`📡 正在請求: ${url}`);
      
      const response = await fetch(url, {
        ...options,
        headers,
        agent,
        timeout: 30000
      });

      console.log(`✅ 回應狀態: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`❌ Request failed for ${endpoint}:`, error.message);
      throw error;
    }
  }

  /**
   * 查詢收衣列表
   * @param {Object} params - 查詢參數（可選）
   */
  async getOrdersList(params = {}) {
    return await this.request('/xiyi-yidianyuan1/ReceivingOrder/SearchPage', {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  /**
   * 查詢單一訂單詳細資料
   * @param {string} orderId - 訂單 ID
   */
  async getOrderDetail(orderId) {
    return await this.request(`/xiyi-yidianyuan1/ReceivingOrder/GetData/${orderId}`, {
      method: 'GET'
    });
  }

  /**
   * 更新配送狀態為已簽收
   * @param {string} deliverOrderId - 配送訂單 ID
   */
  async updateDeliveryStatus(deliverOrderId) {
    return await this.request('/xiyi-yidianyuan1/DeliverOrder/UpdateDeliverState', {
      method: 'POST',
      body: JSON.stringify({
        DeliverOrderID: deliverOrderId
      })
    });
  }

  /**
   * 查詢配送訂單資訊
   * @param {string} deliverOrderId - 配送訂單 ID
   */
  async getDeliveryInfo(deliverOrderId) {
    return await this.request(`/xiyi-yidianyuan1/DeliverOrder/GetData/${deliverOrderId}`, {
      method: 'GET'
    });
  }

  /**
   * 🔥 新增：查詢衣物明細（根據客戶電話）
   * @param {Object} params - 查詢參數
   */
  async getItemsByCustomer(params = {}) {
    return await this.request('/xiyi-yidianyuan1/ReceivingOrder/SearchItemDetailPage', {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }
}

module.exports = { LaundryAPI };
