// =============== aolanReminder.js ===============
require('dotenv').config();
const axios = require('axios');
const dayjs = require('dayjs');

// =============== 常數設定 ===============
const AOLAN_HOST = 'https://hk2.ao-lan.cn';
const AOLAN_TOKEN = process.env.AOLAN_BEARER;
const BRANCH_ID = process.env.BRANCH_ID;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

// =============== 查詢超過7天未取衣物 ===============
async function fetchOverdueOrders() {
 const toDueDate = dayjs().format('YYYY-MM-DDTHH:mm:ss.SSSZZ');
  const url = `${AOLAN_HOST}/xiyi-yidanyuan1/ReceivingOrder/SearchReceivingItemDetailPage`;

  const body = [
    { Key: 'IsSuit', Value: 'false' },
    { Key: 'Remind', Value: 'Remind' },
    { Key: 'ToDueDate', Value: toDueDate },
    { Key: 'BranchID', Value: BRANCH_ID },
    { Key: 'PageIndex', Value: 1 },
    { Key: 'PageSize', Value: 100 },
    { Key: 'PageSummary', Value: true }
  ];

  const headers = {
    Authorization: `Bearer ${AOLAN_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8'
  };

  try {
    const res = await axios.post(url, body, { headers });
    const data = res.data.Data?.List || res.data.Data || [];

    return data;
  } catch (err) {
    console.error('[AOLAN] 查詢失敗:', err.response?.data || err.message);
    return [];
  }
}

// =============== 傳送 LINE 通知 ===============
async function sendLineMessage(text) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: LINE_USER_ID,
        messages: [{ type: 'text', text }]
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ 已發送 LINE 通知');
  } catch (err) {
    console.error('❌ LINE 發送失敗:', err.response?.data || err.message);
  }
}

// =============== 主執行程式 ===============
async function main() {
  console.log('🔍 正在查詢超過 7 天未取的衣物...');
  const list = await fetchOverdueOrders();
  const count = list.length;

  if (count === 0) {
    console.log('🟢 沒有逾期未取的衣物。');
    return;
  }

  const preview = list.slice(0, 5);
  const lines = preview.map((item, i) => {
    const name = item.CustomerName || item.Customer || '不明客戶';
    const phone = item.Mobile || item.Phone || '';
    const masked = phone.length > 6 ? phone.slice(0, 4) + '****' + phone.slice(-3) : phone;
    const due = item.DueDate || item.Due || '未知日期';
    const order = item.ReceivingOrderNumber || item.OrderNumber || '無單號';
    return `${i + 1}. ${name} ${masked} #${order} 到期：${due}`;
  });

  const message =
    `📣 C.H 精緻洗衣《超過7天未取》提醒\n` +
    `時間：${dayjs().format('YYYY/MM/DD HH:mm')}\n` +
    `門市：${BRANCH_ID}\n` +
    `件數：${count} 件\n\n前5筆：\n` +
    lines.join('\n');

  await sendLineMessage(message);
}

// 執行
main();
