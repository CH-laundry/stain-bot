// testAolanApi.js — 超精簡測試
require('dotenv').config();

const BASE   = (process.env.AOLAN_BASE || '').replace(/\/+$/, '');
const PATH   = process.env.AOLAN_TEST_PATH || '/SysConfig/GetVersion';
const METHOD = (process.env.AOLAN_TEST_METHOD || 'GET').toUpperCase();
const BODY   = process.env.AOLAN_TEST_BODY && process.env.AOLAN_TEST_BODY.trim() !== '' ? process.env.AOLAN_TEST_BODY : null;
const TOKEN  = (process.env.AOLAN_BEARER_TOKEN || process.env.Authorization || '').replace(/^Bearer\s+/i,'');

if (!BASE) { console.error('❌ AOLAN_BASE 未設定'); process.exit(1); }

const url = `${BASE}${PATH.startsWith('/') ? PATH : '/' + PATH}`;
const headers = {
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
};

(async () => {
  const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;

  console.log('BASE   =', BASE);
  console.log('PATH   =', PATH);
  console.log('METHOD =', METHOD);
  console.log('TOKEN  =', TOKEN ? 'YES' : 'NO');
  console.log('URL    =', url);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetchFn(url, {
      method: METHOD,
      headers,
      body: METHOD === 'GET' ? undefined : (BODY || '{}'),
      signal: ctrl.signal
    });
    const text = await res.text();
    console.log('↳ 狀態碼：', res.status);
    console.log('↳ 回應前 500 字：\n', (text || '').slice(0, 500));
  } catch (e) {
    console.error('❌ 錯誤：', e.name, e.message);
  } finally {
    clearTimeout(timer);
  }
})();
