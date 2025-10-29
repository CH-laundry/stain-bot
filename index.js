/**
 * C.H 精緻洗衣 — index.js（修正版）
 * 說明：
 * 1) 保留你原有所有功能與模組引用
 * 2) 只在 LINE Pay 相關流程做「防重複」「15 分鐘重用」「手動點擊」三項修正
 * 3) Confirm/Cancel 路由保留；ECPay 流程維持原狀
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');

const logger = require('./services/logger');
const orderManager = require('./services/orderManager');
const messageHandler = require('./services/message');

// 你原本 openai 服務（含 analyzeStainWithAI、smartAutoReply、createECPayPaymentLink）
const { createECPayPaymentLink } = require('./services/openai');

// ============ 基本 App 設定 ============
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 確保 /data 與 /data/uploads 存在（Railway Volume 固定掛載 /data）
const DATA_DIR = '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// ============ 檔案上傳（保留原有行為） ============
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.jpg';
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({ storage });

// 上傳圖片（如你原本就有此路由，保留你的原路由；這段只做兜底）
app.post('/upload', upload.single('image'), (req, res) => {
  try {
    const p = req.file?.path || '';
    logger.logToFile(`✅ 圖片已儲存到 ${p}`);
    res.json({ ok: true, path: p.replace(DATA_DIR, '') });
  } catch (e) {
    logger.logError('圖片上傳失敗', e);
    res.status(500).json({ ok: false, error: 'upload failed' });
  }
});

// ============ LINE Webhook（保留原有行為）===========
app.post('/webhook', async (req, res) => {
  try {
    await messageHandler(req, res);
  } catch (e) {
    logger.logError('Webhook 錯誤', e);
    res.status(500).end();
  }
});

// ============ 公用工具：下載日誌、對外 IP ============
app.get('/log', (_req, res) => {
  try {
    const logPath = path.join(DATA_DIR, 'app.log');
    if (!fs.existsSync(logPath)) return res.status(404).send('沒有日誌');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    fs.createReadStream(logPath).pipe(res);
  } catch (e) {
    logger.logError('讀取日誌失敗', e);
    res.status(500).send('讀取日誌失敗');
  }
});

app.get('/debug/my-ip', async (_req, res) => {
  try {
    const r = await fetch('https://ifconfig.me/ip');
    const ip = (await r.text()).trim();
    logger.logToFile(`SERVER_EGRESS_IP = ${ip}`);
    res.type('text').send(ip);
  } catch (e) {
    logger.logError('取得伺服器對外 IP 失敗', e);
    res.status(500).send('無法取得伺服器 IP');
  }
});

// ============ LINE Pay 設定（保留環境變數） ============
const LINE_PAY_CONFIG = {
  apiUrl: process.env.LINE_PAY_API_URL || 'https://api-pay.line.me',
  channelId: process.env.LINE_PAY_CHANNEL_ID,
  channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
};

// Base URL（Railway 建議用 RAILWAY_PUBLIC_DOMAIN）
const BASE_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  process.env.PUBLIC_BASE_URL ||
  'https://stain-bot-production-0fac.up.railway.app';

// ============ LINE Pay Helper（簽章） ============
function generateLinePaySignature(uri, body, nonce) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const signatureStr = `${LINE_PAY_CONFIG.channelSecret}${uri}${bodyStr}${nonce}`;
  const signature = crypto
    .createHmac('sha256', LINE_PAY_CONFIG.channelSecret)
    .update(signatureStr)
    .digest('base64');
  return signature;
}

// ============ LINE Pay：建立交易（不使用 capture: true） ============
async function createLinePayPayment(userId, userName, amount) {
  try {
    const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    const nonce = crypto.randomBytes(16).toString('base64');

    const requestBody = {
      amount: amount,
      currency: 'TWD',
      orderId: orderId,
      packages: [
        {
          id: orderId,
          amount: amount,
          name: 'C.H精緻洗衣服務',
          products: [{ name: '洗衣清潔費用', quantity: 1, price: amount }],
        },
      ],
      redirectUrls: {
        confirmUrl: `${BASE_URL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(
          userName || ''
        )}&amount=${amount}`,
        cancelUrl: `${BASE_URL}/payment/linepay/cancel`,
      },
      // ⚠️ 故意不加 options.payment.capture
    };

    const uri = '/v3/payments/request';
    const signature = generateLinePaySignature(uri, requestBody, nonce);

    const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': signature,
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();
    logger.logToFile(`📥 LINE Pay API 回應: ${JSON.stringify(result)}`);
    logger.logToFile(`📥 返回碼: ${result.returnCode}, 訊息: ${result.returnMessage}`);

    if (result.returnCode === '0000') {
      const paymentUrlApp = result.info?.paymentUrl?.app || null;
      const paymentUrlWeb = result.info?.paymentUrl?.web || null;

      if (paymentUrlApp) logger.logToFile(`✅ paymentUrl.app: ${paymentUrlApp}`);
      if (paymentUrlWeb) logger.logToFile(`✅ paymentUrl.web: ${paymentUrlWeb}`);

      return {
        success: true,
        paymentUrlApp,
        paymentUrlWeb,
        paymentUrl: paymentUrlApp || paymentUrlWeb,
        orderId,
        transactionId: result.info?.transactionId,
        paymentAccessToken: result.info?.paymentAccessToken,
      };
    }

    logger.logToFile(`❌ LINE Pay 失敗: ${result.returnCode} - ${result.returnMessage}`);
    return { success: false, error: result.returnMessage || 'LINE Pay request failed' };
  } catch (error) {
    logger.logError('LINE Pay 請求錯誤', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

// ============ LINE Pay：持久付款頁 防重複＋15分鐘重用 ============
const linePayLocks = new Map();
async function withLinePayLock(orderId, fn) {
  if (linePayLocks.get(orderId)) {
    const err = new Error('DUPLICATE_LINEPAY_REQUEST');
    throw err;
  }
  linePayLocks.set(orderId, true);
  try {
    return await fn();
  } finally {
    setTimeout(() => linePayLocks.delete(orderId), 1500);
  }
}

// 手動點擊版頁面（避免自動跳轉被 LINE 攔截）
function renderLinePayPage(orderId, amount, remainingHours, paymentUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LINE Pay 付款</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:40px;background:linear-gradient(135deg,#06C755,#00B900);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:28px;max-width:480px;margin:0 auto;box-shadow:0 8px 32px rgba(0,0,0,0.2)}
h1{font-size:26px;margin-bottom:20px;font-weight:700}
.info{background:rgba(255,255,255,0.2);border-radius:12px;padding:16px;margin:20px 0;font-size:15px}
.btn{display:block;width:100%;padding:16px;background:#fff;color:#06C755;text-decoration:none;border-radius:12px;font-weight:700;margin-top:20px;font-size:17px;border:none;cursor:pointer;transition:all 0.2s}
.btn:active{transform:scale(0.98);opacity:0.8}
.btn.disabled{opacity:0.5;cursor:not-allowed}
.note{font-size:13px;opacity:0.9;margin-top:16px;line-height:1.5}
.warning{background:rgba(255,200,0,0.25);padding:12px;border-radius:8px;margin:16px 0;font-size:14px;line-height:1.5}
</style>
</head><body>
<div class="container">
  <h1>💳 LINE Pay 付款</h1>
  <div class="info">
    <div>訂單: ${orderId}</div>
    <div style="font-size:24px;font-weight:700;margin:12px 0">NT$ ${Number(amount || 0).toLocaleString()}</div>
    <div>有效期: ${remainingHours} 小時</div>
  </div>
  <div class="warning">
    ⚠️ 請在 <b>LINE App 內</b>開啟此頁面；若在外部瀏覽器可能無法付款
  </div>
  <button id="payBtn" class="btn" onclick="handlePay()">
    🔓 前往 LINE Pay 付款
  </button>
  <p class="note">
    點擊按鈕後請完成付款<br>
    <b style="color:#FFE66D">⚠️ 付款過程中請勿重複點擊或關閉頁面</b><br>
    完成後系統會自動通知
  </p>
</div>
<script>
let processing = false;
const paymentUrl = "${paymentUrl}";
function handlePay() {
  if (processing) { alert('處理中，請稍候...'); return; }
  processing = true;
  const btn = document.getElementById('payBtn');
  btn.classList.add('disabled');
  btn.textContent = '⏳ 跳轉中...';
  setTimeout(function(){ window.location.href = paymentUrl; }, 250);
  setTimeout(function(){
    if (document.visibilityState === 'visible') {
      processing = false;
      btn.classList.remove('disabled');
      btn.textContent = '🔓 前往 LINE Pay 付款';
    }
  }, 5000);
}
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && processing) {
    setTimeout(function(){
      processing = false;
      const btn = document.getElementById('payBtn');
      if (btn){
        btn.classList.remove('disabled');
        btn.textContent = '🔓 前往 LINE Pay 付款';
      }
    }, 2000);
  }
});
</script>
</body></html>`;
}

function renderErrorPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white;margin:0}
.container{background:rgba(255,255,255,0.15);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}
h1{font-size:28px;margin-bottom:16px}
p{font-size:16px;line-height:1.6}
</style>
</head><body>
<div class="container">
  <h1>⚠️ ${title}</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

// 付款頁面（持久 URL）
app.get('/payment/linepay/pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = orderManager.getOrder(orderId);

  if (!order) return res.status(404).send(renderErrorPage('訂單不存在', '找不到此訂單'));

  if (orderManager.isExpired(orderId)) {
    const hoursPassed = ((Date.now() - (order.createdAt || Date.now())) / (1000 * 60 * 60)).toFixed(1);
    logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed} 小時)`);
    return res.send(renderErrorPage('訂單已過期', `此訂單已超過 7 天<br>訂單編號: ${orderId}`));
  }

  if (order.status === 'paid') {
    return res.send(renderErrorPage('訂單已付款', `此訂單已完成付款<br>訂單編號: ${orderId}`));
  }

  try {
    let paymentUrl = null;

    // 15 分鐘內重用既有交易
    if (order.linepayTransactionId && order.linepayPaymentUrl && order.lastLinePayRequestAt) {
      const elapsed = Date.now() - order.lastLinePayRequestAt;
      if (elapsed < 15 * 60 * 1000) {
        paymentUrl = order.linepayPaymentUrl;
        logger.logToFile(`↩️ 重用既有 LINE Pay 連結: ${orderId}（${Math.floor(elapsed / 1000)} 秒前建立）`);
      } else {
        logger.logToFile(`⏰ 既有連結已逾 15 分鐘（${Math.floor(elapsed / 60000)} 分），將建立新交易`);
      }
    }

    // 無有效連結 → 上鎖建立新交易
    if (!paymentUrl) {
      const result = await withLinePayLock(orderId, async () => {
        logger.logToFile(`🔄 建立新的 LINE Pay 交易: ${orderId}`);
        const lp = await createLinePayPayment(order.userId, order.userName, order.amount);

        if (!lp.success) {
          return { ok: false, error: lp.error || '建立交易失敗' };
        }

        const url = lp.paymentUrlApp || lp.paymentUrlWeb || lp.paymentUrl;
        orderManager.updatePaymentInfo(orderId, {
          linepayTransactionId: lp.transactionId,
          linepayPaymentUrl: url,
          lastLinePayRequestAt: Date.now(),
        });

        logger.logToFile(`✅ LINE Pay 交易建立成功: ${lp.transactionId}`);
        return { ok: true, paymentUrl: url };
      });

      if (!result.ok) {
        return res.status(500).send(renderErrorPage('付款連結生成失敗', result.error || '請稍後重試'));
      }
      paymentUrl = result.paymentUrl;
    }

    const remainingHours = Math.max(
      0,
      Math.floor(((order.expiryTime || Date.now()) - Date.now()) / (1000 * 60 * 60))
    );
    return res.send(renderLinePayPage(orderId, order.amount, remainingHours, paymentUrl));
  } catch (error) {
    if (error && error.message === 'DUPLICATE_LINEPAY_REQUEST') {
      logger.logToFile(`⚠️ 阻擋重複請求: ${orderId}`);
      return res
        .status(429)
        .send(renderErrorPage('請稍候', '付款頁面正在生成中<br>請勿重複點擊<br>請於 3 秒後重新整理'));
    }
    logger.logError('LINE Pay 付款頁面錯誤', error);
    return res.status(500).send(renderErrorPage('系統錯誤', '請稍後重試或聯繫客服'));
  }
});

// ============ LINE Pay：Confirm / Cancel ============
app.get('/payment/linepay/confirm', async (req, res) => {
  const { transactionId, orderId } = req.query;
  logger.logToFile(`✅ 收到 confirm callback: transactionId=${transactionId}, orderId=${orderId}`);

  try {
    const order = orderManager.getOrder(orderId);
    if (!order) return res.status(404).send('order not found');

    // 呼叫 Confirm API
    const uri = `/v3/payments/${transactionId}/confirm`;
    const nonce = crypto.randomBytes(16).toString('base64');
    const body = { amount: order.amount, currency: 'TWD' };
    const sig = generateLinePaySignature(uri, body, nonce);

    const r = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': sig,
      },
      body: JSON.stringify(body),
    });

    const result = await r.json();
    logger.logToFile(`💡 Confirm 結果: ${JSON.stringify(result)}`);

    if (result.returnCode === '0000') {
      orderManager.markPaid(orderId, { transactionId });
      return res.send('<meta charset="utf-8">付款成功，您可以關閉此頁面。');
    } else {
      return res
        .status(400)
        .send(`<meta charset="utf-8">付款確認失敗：${result.returnMessage || result.returnCode}`);
    }
  } catch (e) {
    logger.logError('Confirm 失敗', e);
    res.status(500).send('<meta charset="utf-8">系統錯誤，請稍後再試');
  }
});

app.get('/payment/linepay/cancel', (_req, res) => {
  res.send('<meta charset="utf-8">您已取消付款。');
});

// ============ 發送付款連結（保持原功能，僅替換 linepay 區塊） ============
app.post('/send-payment', async (req, res) => {
  try {
    const { userId, userName, amount, type } = req.body;
    const numAmount = Number(amount || 0);
    if (!userId || !numAmount) return res.status(400).json({ ok: false, error: 'params invalid' });

    let linepayLink = null;
    let ecPayLink = null;

    // —— LINE Pay：建立交易 → 存到訂單 → 給持久付款頁連結（有縮網址）
    if (type === 'linepay' || type === 'both') {
      const lp = await createLinePayPayment(userId, userName, numAmount);
      if (lp.success) {
        const linePayOrderId = lp.orderId;

        // 建立／更新訂單
        orderManager.createOrder(linePayOrderId, { userId, userName, amount: numAmount });
        const paymentUrl = lp.paymentUrlApp || lp.paymentUrlWeb || lp.paymentUrl;
        orderManager.updatePaymentInfo(linePayOrderId, {
          linepayTransactionId: lp.transactionId,
          linepayPaymentUrl: paymentUrl,
          lastLinePayRequestAt: Date.now(),
        });
        logger.logToFile(`✅ 建立 LINE Pay 訂單: ${linePayOrderId}`);

        // 組持久連結
        const rawLink = `${BASE_URL}/payment/linepay/pay/${linePayOrderId}`;

        // 縮網址（可失敗）
        try {
          const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(rawLink)}`);
          const s = await r.text();
          linepayLink = /^https?:\/\//i.test(s) ? s : rawLink;
        } catch {
          linepayLink = rawLink;
          logger.logToFile('⚠️ 短網址失敗，使用原連結');
        }
      } else {
        logger.logToFile(`❌ LINE Pay 建立失敗：${lp.error || '未知錯誤'}`);
      }
    }

    // —— ECPay：維持你原本的方式（不動）
    if (type === 'ecpay' || type === 'both') {
      try {
        ecPayLink = await createECPayPaymentLink(userId, userName, numAmount);
      } catch (e) {
        logger.logError('ECPay 建立失敗', e);
      }
    }

    // 回傳你現有需要的資訊（保持原有回應格式）
    return res.json({
      ok: true,
      userId,
      userName,
      amount: numAmount,
      linepayLink,
      ecPayLink,
      type,
    });
  } catch (e) {
    logger.logError('send-payment 失敗', e);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ============ 其它你原本就有的路由／功能（不動）===========
// 例如：查詢進度、FAQ、靜態頁、健康檢查等
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ============ 啟動伺服器 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.logToFile(`🚀 Server started on :${PORT}`);
});
