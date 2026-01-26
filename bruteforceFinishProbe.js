/**
 * bruteforceFinishProbe.js
 * 目的：在已知 Base 下，嘗試常見的「清潔完成」端點路徑/方法/參數（JSON 與 x-www-form-urlencoded），
 *      找到第一個「不是 404」的組合就輸出，幫你鎖定正確呼叫方式。
 *
 * 使用：
 *   $env:ORDER_ID = '實際訂單ID'
 *   # 可選：若該端點需要 Bearer token（只允許 ASCII）
 *   # $env:AOLAN_BEARER_TOKEN = 'xxxxx'
 *   node .\bruteforceFinishProbe.js
 */

require('dotenv').config();

const BASE  = (process.env.AOLAN_BASE || '').replace(/\/+$/,'');
const TOKEN = (process.env.AOLAN_BEARER_TOKEN || '').replace(/^Bearer\s+/i,'').replace(/[^\x00-\x7F]/g,'');
const ORDER_ID = process.env.ORDER_ID || '';

if (!BASE) { console.error('❌ 缺少 AOLAN_BASE'); process.exit(1); }
if (!ORDER_ID) { console.error('❌ 缺少 ORDER_ID（請用環境變數帶入一筆要測的訂單 ID）'); process.exit(1); }

const HEADERS_JSON = (tk) => ({
  'Content-Type': 'application/json',
  ...(tk ? { Authorization: `Bearer ${tk}` } : {})
});
const HEADERS_FORM = (tk) => ({
  'Content-Type': 'application/x-www-form-urlencoded',
  ...(tk ? { Authorization: `Bearer ${tk}` } : {})
});
const enc = (o) => Object.entries(o).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const candidatePaths = [
  // 你目前猜的
  '/Order/UpdateFinish',
  // 常見命名
  '/Order/Finish',
  '/Order/Complete',
  '/Order/SetFinish',
  '/Order/SetCompleted',
  '/Order/UpdateCompleted',
  '/Order/MarkFinished',
  '/Order/MarkComplete',
  // 可能有大小寫或複數
  '/Orders/Finish',
  '/Orders/Complete',
  // 另一種模組名（有些會叫 WorkOrder/ServiceOrder）
  '/WorkOrder/Finish',
  '/ServiceOrder/Finish',
  '/Service/Order/Finish',
  // 帶 api 前綴（某些舊程式會混用）
  '/api/Order/UpdateFinish',
  '/api/Order/Finish',
  '/api/Order/Complete',
  // ABP/ASP.NET 常見服務路徑
  '/api/services/app/Order/UpdateFinish',
  '/api/services/app/Order/Finish',
  '/api/services/app/Order/Complete',
  // 帶動詞在前
  '/api/services/app/Finish/Order',
  '/api/services/app/Complete/Order',
];

const candidateParams = [
  // JSON / form 都會試這些 Key 形狀
  (id) => ({ OrderId: id }),
  (id) => ({ orderId: id }),
  (id) => ({ Id: id }),
  (id) => ({ id: id }),
  (id) => ({ OrderNo: id }),
  (id) => ({ orderNo: id }),
  // 有些要求同時帶狀態
  (id) => ({ OrderId: id, Status: 'CLEANED' }),
  (id) => ({ orderId: id, status: 'CLEANED' }),
];

const methods = ['POST','GET'];

const combos = [];
for (const p of candidatePaths) {
  for (const m of methods) {
    // no body
    combos.push({ method: m, path: p, kind: 'none' });

    // JSON bodies
    for (const maker of candidateParams) {
      const obj = maker(ORDER_ID);
      combos.push({ method: 'POST', path: p, kind: 'json', body: JSON.stringify(obj) });
      // GET with querystring
      combos.push({ method: 'GET', path: p + '?' + enc(obj), kind: 'qs' });
      // FORM
      combos.push({ method: 'POST', path: p, kind: 'form', body: enc(obj) });
    }
  }
}

const withFetch = async () => {
  if (typeof fetch === 'function') return fetch;
  const mod = await import('node-fetch');
  return mod.default;
};

(async () => {
  const f = await withFetch();
  console.log('BASE =', BASE);
  console.log('ORDER_ID =', ORDER_ID);
  console.log('TOKEN =', TOKEN ? 'YES' : 'NO');
  console.log(`嘗試組合數：${combos.length}`);

  for (const [i, c] of combos.entries()) {
    const url = BASE + (c.path.startsWith('/') ? c.path : '/' + c.path);
    const headers = c.kind === 'form' ? HEADERS_FORM(TOKEN) : HEADERS_JSON(TOKEN);
    const body = (c.method === 'POST')
      ? (c.kind === 'json' ? c.body
         : c.kind === 'form' ? c.body
         : undefined)
      : undefined;

    console.log(`\n[${i+1}/${combos.length}] 🔎 ${c.method} ${url}`);
    if (body) console.log('  body =', body);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);

      const res = await f(url, { method: c.method, headers, body, signal: ctrl.signal });
      clearTimeout(timer);

      const text = await res.text();
      const head = (text || '').slice(0, 300);
      console.log('  ↳ 狀態：', res.status);
      if (head) console.log('  ↳ 內容前 300 字：\n', head);

      // 命中判斷：只要不是 404 就先視為候選（200/400/401/403 都行）
      if (res.status !== 404) {
        console.log('\n✅ 找到非 404 的候選！請記下以下參數：');
        console.log('  METHOD =', c.method);
        console.log('  PATH   =', c.path);
        if (body) console.log('  BODY   =', body);
        console.log('\n請把這三個值填進 notifyAfter2min.js（或用環境變數覆寫）再做 2 分鐘推播測試。');
        return;
      }
    } catch (e) {
      console.log('  ❌ 錯誤：', e.name, e.message);
    }
  }

  console.log('\n🚨 全部組合都 404/失敗。下一步：請在 Fiddler 把你按「清潔完成」時那一筆的 Raw Request（Method/URL/Body）複製出來。');
})();
