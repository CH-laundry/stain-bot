// testAolanApi.js
require('dotenv').config();
const fetch = require('node-fetch');

(async () => {
  const base = process.env.AOLAN_BASE;
  const tenant = process.env.AOLAN_TENANT;
  const token = process.env.AOLAN_BEARER_TOKEN;

  if (!base || !tenant || !token) {
    console.error('❌ 缺少必要的環境變數：請確認 AOLAN_BASE, AOLAN_TENANT, AOLAN_BEARER_TOKEN 已設定');
    process.exit(1);
  }

  const url = `${base}${tenant}/api/Order/GetOrders`; // 常見的訂單查詢端點
  console.log(`🧩 嘗試連線：${url}`);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    console.log(`🔗 狀態碼：${res.status}`);

    const text = await res.text();
    if (res.ok) {
      console.log('✅ API 回應成功');
      console.log('--- 回傳內容 (前 500 字) ---');
      console.log(text.slice(0, 500));
    } else {
      console.log('⚠️ API 回應非 200：');
      console.log(text.slice(0, 300));
    }
  } catch (err) {
    console.error('❌ 發送失敗：', err.message);
  }
})();
