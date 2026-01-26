// probeUpdateFinish.js — 嘗試找出 /Order/UpdateFinish 的正確呼叫方式
require('dotenv').config();

const BASE  = (process.env.AOLAN_BASE || '').replace(/\/+$/, '');
const TOKEN = (process.env.AOLAN_BEARER_TOKEN || '').replace(/^Bearer\s+/i, '');
const ORDER_ID = process.env.TEST_ORDER_ID || ''; // 你可先留空讓它拿到 "缺參數" 的錯誤訊息

if (!BASE) { console.error('❌ 缺少 AOLAN_BASE'); process.exit(1); }

const fetchFn = typeof fetch === 'function' ? fetch : (async () => (await import('node-fetch')).default)();

const HEADERS_JSON = (tk) => ({
  'Content-Type': 'application/json',
  ...(tk ? { Authorization: `Bearer ${tk.replace(/[^\x00-\x7F]/g, '')}` } : {})
});

const HEADERS_FORM = (tk) => ({
  'Content-Type': 'application/x-www-form-urlencoded',
  ...(tk ? { Authorization: `Bearer ${tk.replace(/[^\x00-\x7F]/g, '')}` } : {})
});

const combos = [
  { method: 'GET',  path: '/Order/UpdateFinish?OrderId=' + encodeURIComponent(ORDER_ID) },
  { method: 'GET',  path: '/Order/UpdateFinish?orderId=' + encodeURIComponent(ORDER_ID) },

  { method: 'POST', path: '/Order/UpdateFinish', headers: 'json', body: JSON.stringify({ OrderId: ORDER_ID }) },
  { method: 'POST', path: '/Order/UpdateFinish', headers: 'json', body: JSON.stringify({ orderId: ORDER_ID }) },
  { method: 'POST', path: '/Order/UpdateFinish', headers: 'form', body: 'OrderId=' + encodeURIComponent(ORDER_ID) },
  { method: 'POST', path: '/Order/UpdateFinish', headers: 'form', body: 'orderId=' + encodeURIComponent(ORDER_ID) },
  { method: 'POST', path: '/Order/UpdateFinish' }, // 無 body
];

(async () => {
  const f = await fetchFn;
  console.log('BASE =', BASE);
  console.log('ORDER_ID =', ORDER_ID || '(空)');
  for (const c of combos) {
    const url = BASE + c.path;
    const method = c.method;
    const headers = c.headers === 'form' ? HEADERS_FORM(TOKEN) :
                    c.headers === 'json' ? HEADERS_JSON(TOKEN) : HEADERS_JSON(TOKEN);
    console.log(`\n🔎 ${method} ${url}`);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await f(url, { method, headers, body: c.body, signal: ctrl.signal });
      clearTimeout(t);
      const text = await res.text();
      console.log('  ↳ 狀態碼：', res.status);
      console.log('  ↳ 內容前 400 字：\n', (text || '').slice(0, 400));

      // 命中條件：不是 404；或訊息明確顯示缺少某參數（幫你辨識參數名）
      if (res.status !== 404) {
        console.log('✅ 命中（非 404）。把這條記下來：', method, c.path, c.body ? `body=${c.body}` : '');
        return;
      }
    } catch (e) {
      console.log('  ❌ 錯誤：', e.name, e.message);
    }
  }
  console.log('\n🚨 沒找到非 404 的呼叫方式。請在 Fiddler 打開 /Order/UpdateFinish 那筆，貼我 "Raw" 的方法、URL、Body。');
})();
