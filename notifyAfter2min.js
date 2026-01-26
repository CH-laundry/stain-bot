require('dotenv').config({ override: false });
const fetch = require('node-fetch');

// ---------- Aolan 參數 ----------
const BASE   = (process.env.AOLAN_BASE || '').replace(/\/+$/, '');
const PATH   = (process.env.AOLAN_UPDATE_PATH || '/Appointment/UpdateDone').trim();
const METHOD = (process.env.AOLAN_UPDATE_METHOD || 'GET').toUpperCase();
const ORDER  = (process.env.ORDER_ID || '').trim();
let   token  = (process.env.AOLAN_BEARER_TOKEN || '').trim().replace(/^Bearer\s+/i, '');

// ---------- LINE 參數 ----------
const LINE_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
const LINE_TO    = (process.env.LINE_TEST_USER_ID || '').trim();

// ---------- 通知延遲 ----------
const DELAY_SEC  = Number(process.env.NOTIFY_DELAY_SEC || 120);
const DELAY_MS   = Math.max(0, DELAY_SEC) * 1000;

// ---------- 基本檢查 ----------
if (!BASE || !PATH || !ORDER) {
  console.error('❌ 缺少必要參數：AOLAN_BASE / AOLAN_UPDATE_PATH / ORDER_ID');
  process.exit(1);
}
if (!token || /[\u4e00-\u9fff]/.test(token) || token.includes('把你的') || token.includes('實際JWT')) {
  console.error('❌ AOLAN_BEARER_TOKEN 無效或未設定（請在同一個 PowerShell 視窗設定正確 JWT）');
  process.exit(1);
}
if (!LINE_TOKEN || !LINE_TO) {
  console.error('❌ LINE_CHANNEL_ACCESS_TOKEN 或 LINE_TEST_USER_ID 未設定（請先放到 .env 或用 $env: 設定）');
  process.exit(1);
}

// ---------- 工具 ----------
async function callAolanUpdateDone() {
  const url = `${BASE}${PATH}/${ORDER}`.replace(/([^:])\/{2,}/g, '$1/');
  const headers = { Authorization: `Bearer ${token}` };

  console.log('BASE   =', BASE);
  console.log('PATH   =', PATH);
  console.log('METHOD =', METHOD);
  console.log('ORDER  =', ORDER);
  console.log('👉 呼叫清潔完成：', METHOD, url);

  const res  = await fetch(url, { method: METHOD, headers });
  const text = await res.text();
  console.log('↳ 狀態碼：', res.status);
  console.log('↳ 內容前 300 字：\n', text.slice(0, 300));

  // 嘗試解析 {"Data":"","Status":200,"Message":""}
  let ok = false;
  try {
    const j = JSON.parse(text);
    ok = (res.status === 200) && (j && j.Status === 200);
  } catch (_) {
    ok = (res.status === 200);
  }
  return ok;
}

async function pushLineText(to, text) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text }]
    })
  });
  const body = await res.text();
  console.log('🟢 LINE push status:', res.status, 'body:', body.slice(0, 300));
  return res.ok;
}

// ---------- 主流程 ----------
(async () => {
  try {
    const ok = await callAolanUpdateDone();
    if (!ok) {
      console.error('❌ Aolan 端點未回 200/Status=200，終止後續 LINE 通知。');
      process.exit(1);
    }

    console.log(`⏱️ ${DELAY_SEC} 秒後發 LINE 通知…（測試時可把 NOTIFY_DELAY_SEC 設短一點）`);
    setTimeout(async () => {
      const msg =
        `🧼 清潔完成通知\n` +
        `訂單已標記為完成（ID: ${ORDER.substring(0, 8)}…）。\n` +
        `這是測試訊息（${DELAY_SEC} 秒延遲推送）。`;

      try {
        const ok = await pushLineText(LINE_TO, msg);
        if (ok) {
          console.log('✅ LINE 訊息已送出。');
        } else {
          console.error('❌ LINE 訊息推送失敗。');
        }
      } catch (e) {
        console.error('❌ LINE 推送例外：', e?.message || e);
      }
    }, DELAY_MS);
  } catch (e) {
    console.error('❌ 例外：', e?.message || e);
    process.exit(1);
  }
})();
