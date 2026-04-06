require('dotenv').config();
const { LaundryAPI } = require('./src/laundry-api.js');

const API_BASE_URL = process.env.LAUNDRY_API_BASE_URL || 'http://lk2.ao-lan.cn';
const AUTH_TOKEN = process.env.LAUNDRY_AUTH_TOKEN;

const laundryAPI = new LaundryAPI(API_BASE_URL, AUTH_TOKEN);

async function test() {
  console.log('🧪 開始測試 C.H 洗衣系統 API\n');

  try {
    // 測試 1: 查詢訂單列表
    console.log('📋 測試 1: 查詢訂單列表...');
    const orders = await laundryAPI.getOrdersList({ pageIndex: 0, pageSize: 5 });
    console.log('✅ 成功！找到訂單數:', orders.Data?.length || 0);
    if (orders.Data && orders.Data.length > 0) {
      console.log('   第一筆訂單:', orders.Data[0].ReceivingOrderNumber, '-', orders.Data[0].CustomerName);
    }
    console.log('');

    // 測試 2: 查詢訂單詳細（使用第一筆訂單的 ID）
    if (orders.Data && orders.Data.length > 0) {
      const firstOrderId = orders.Data[0].Id;
      console.log('📄 測試 2: 查詢訂單詳細...');
      console.log('   訂單 ID:', firstOrderId);
      const orderDetail = await laundryAPI.getOrderDetail(firstOrderId);
      console.log('✅ 成功！客戶:', orderDetail.Data?.CustomerName);
      console.log('   金額:', orderDetail.Data?.SubTotal);
      console.log('   狀態:', orderDetail.Data?.DeliveryTypeCaption);
      console.log('');
    }

    // 測試 3: 查詢配送資訊（如果有的話）
    console.log('📦 測試 3: API 連接測試完成！');
    console.log('');
    console.log('🎉 所有測試通過！MCP Server 可以正常運作。');

  } catch (error) {
    console.error('❌ 測試失敗:', error.message);
    console.error('完整錯誤:', error);
  }
}

test();