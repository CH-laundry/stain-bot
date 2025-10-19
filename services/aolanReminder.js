// aolanReminder.js —— 查「到今天為止」的提醒清單，只推給自己
require('dotenv').config();
const axios = require('axios');
const dayjs = require('dayjs');

const AOLAN_BASE  = process.env.AOLAN_BASE || 'https://hk2.aolan.cn'; // 若你用 www.aolan.net 就改 .env
const AOLAN_TOKEN = process.env.AOLAN_BEARER;       // 你剛複製的 Bearer（很長那串）
const BRANCH_ID   = process.env.BRANCH_ID;          // 你門市的 BranchID
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER   = process.env.LINE_USER_ID;       // 你的 userId

// 👉 改成「今天」：查到今天為止（包含今天的單）
const toDueDateToday = () => dayjs().format('YYYY-MM-DDTHH:mm:ss.SSSZZ');

// 這支就是你在 Fiddler 看到的批次查詢 API
const API = `${AOLAN_BASE}/xiyi-yidanyuan1/ReceivingOrder/SearchReceivingItemDetailPage`;

// 做一頁查詢的 payload（照你抓到的 Key/Value）
function buildPayload(pageIndex = 1, pageSize = 100) {
  return [
    { Key: 'IsSuit',    Value: 'false' },
    { Key: 'Remind',    Value: 'Remind' },                      // 只要提醒清單（清潔完成未取）
    { Key: 'ToDueDate', Value: toDueDateToday() },              // ✅ 到今天為止
    { Key: 'BranchID',  Value: BRANCH_ID },
    { Key: 'PageIndex', Value: pageIndex },
    { Key: 'PageSize',  Value: pageSize },
    { Key: 'PageSummary', Value: pageIndex === 1 ? 'true' : 'false' }
  ];
}

// 將回應轉成陣列（不同版本結構容錯）
function normalizeList(resData) {
  if (Array.isArray(resData?.Data)) return resData.Data;
  if (Array.isArray(resData?.Data?.List)) return resData.Data.List;
  if (Array.isArray(resData)) return resData;
  if (Array.isArray(resData?.Message)) return resData.Message;
  return [];
}

async function fetchTodayList() {
  const headers = {
    Authorization: `Bearer ${AOLAN_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8'
  };

  let page = 1;
  const pageSize = 100;
  const all = [];

  while (true) {
    const body = buildPayload(page, pageSize);
    console.log('[AOLAN] URL:', API, 'Page:', page);

    let res;
    try {
      res = await axios.post(API, body, { headers });
    } catch (e) {
      // 有些空結果會回 404 HTML；直接當成空頁
      const txt = e?.response?.data;
      const isHtml404 = typeof txt === 'string' && txt.includes('<title>404');
      if (isHtml404) {
        console.log('[AOLAN] 空頁（404 HTML）');
        break;
      }
      throw e;
    }

    const list = normalizeList(res.data);
    if (!list.length) break;

    all.push(...list);
    if (list.length < pageSize) break;
    page++;
  }

  return all;
}

async function pushToMe(text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: LINE_USER, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

function maskPhone(p) {
  if (!p || typeof p !== 'string') return '';
  return p.length >= 10 ? p.slice(0, 4) + '****' + p.slice(-3) : p;
}

(async () => {
  try {
    console.log('🔍 查詢「到今天為止」的清潔完成未取清單（只推給自己）...');
    const list = await fetchTodayList();

    const count = list.length;
    const preview = list.slice(0, 5).map((x, i) => {
      const name  = x.CustomerName || x.Customer || '未提供';
      const phone = maskPhone(x.Mobile || x.ContactMobile || x.Phone || '');
      const order = x.ReceivingOrderNumber || x.ReceivingOrderNo || x.OrderNumber || '-';
      const due   = (x.DueDate || x.LocationDate || x.CreatedDate || '').toString().replace('T',' ').slice(0,16);
      const goods = x.GoodsName || x.SpecificationName || '';
      return `${i+1}. ${name} ${phone} #${order} ${goods ? '品項:'+goods+' ' : ''}日期:${due}`;
    });

    const message =
      `📣 C.H 精緻洗衣〈到今天為止的清單〉\n` +
      `時間：${dayjs().format('YYYY/MM/DD HH:mm')}\n` +
      `門市：${BRANCH_ID}\n` +
      `件數：${count} 件` +
      (preview.length ? `\n\n前5筆：\n${preview.join('\n')}` : '');

    await pushToMe(message);
    console.log('✅ 已發送到你的 LINE（只推你，不推客人）');
  } catch (err) {
    console.error('❌ 執行失敗：', err?.response?.data || err.message);
  }
})();
