// =============== aolanReminder.js ===============
require('dotenv').config();
const axios = require('axios');
const dayjs = require('dayjs');

// =============== 常數設定 ===============
const AOLAN_HOST = 'https://hk2.aolan.cn'; // ✅ 修正為正確主機（不要有連字號）
const AOLAN_TOKEN = process.env.AOLAN_BEARER;
const BRANCH_ID = process.env.BRANCH_ID;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

// =============== 查詢今天以前的清潔完成未取衣物 ===============
async function fetchOrders() {
  // 改成「查今天以前」的所有資料
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

  console.log('[AOLAN] 查詢網址：', url);
  console.log('[AOLAN] 查詢時間條件：', toDueDate);

  try {
    const res = await axios.post(url, body, { headers });
    const data = res.data.Data?.List || res.data.Data || [];

    console.log(`[AOLAN] 查到 ${data.length} 筆資料`);
    return data;
  } catch (err) {
    console.error('[AOLAN] 查詢失敗:', err.response?.data || err.message);
    return [];
  }
}

// =============== 傳送 LINE 通知（只發給自己） ===============
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
    console.log('✅ 成功發送 LINE 通知');
  } catch (err) {
    console.error('❌ LINE 發送失敗:', err.response?.data || err.message);
  }
}

// =============== 主執行程式 ===============
async function main() {
  console.log('🔍 正在查詢今天以前（含今天）的清潔完成未取衣物...');
  const list = await fetchOrders();
  const count = list.length;

  const message = 
    `📣 C.H 精緻洗衣《測試模式》提醒\n` +
    `時間：${dayjs().format('YYYY/MM/DD HH:mm')}\n` +
    `件數：${count} 件\n` +
    (count > 0 ? `\n前幾筆資料：\n` + 
      list.slice(0, 5).map((item, i) => {
        const name = item.CustomerName || '未知';
        const phone = item.Mobile || '';
        const masked = phone.length > 6 ? phone.slice(0, 4) + '****' + phone.slice(-3) : phone;
        const due = item.DueDate || '未知';
        const order = item.ReceivingOrderNumber || '無單號';
        return `${i + 1}. ${name} ${masked} #${order} 到期：${due}`;
      }).join('\n')
    : `\n🟢 沒有符合條件的衣物。`);

  await sendLineMessage(message);
}

// 執行
main();
