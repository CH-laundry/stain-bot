import fetch from 'node-fetch';

/**
 * C.H 洗衣系統 API 客戶端
 */
export class LaundryAPI {
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

    try {
      const response = await fetch(url, {
        ...options,
        headers
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  /**
   * 查詢收衣列表
   * @param {Object} params - 查詢參數（可選）
   */
  async getOrdersList(params = {}) {
    return await this.request('/ayi-yidanyuan1/ReceivingOrder/SearchPage', {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  /**
   * 查詢單一訂單詳細資料
   * @param {string} orderId - 訂單 ID
   */
  async getOrderDetail(orderId) {
    return await this.request(`/ayi-yidanyuan1/ReceivingOrder/GetData/${orderId}`, {
      method: 'GET'
    });
  }

  /**
   * 更新配送狀態為已簽收
   * @param {string} deliverOrderId - 配送訂單 ID
   */
  async updateDeliveryStatus(deliverOrderId) {
    return await this.request('/ayi-yidanyuan1/DeliverOrder/UpdateDeliverState', {
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
    return await this.request(`/ayi-yidanyuan1/DeliverOrder/GetData/${deliverOrderId}`, {
      method: 'GET'
    });
  }
}
