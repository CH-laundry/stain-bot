// ============================================
// 🔧 修復 LINE Pay 登入 & 支付問題
// ============================================

// 1️⃣ 修改 createLinePayPayment 函數（約在第 87 行）
async function createLinePayPayment(userId, userName, amount) {
    try {
        const orderId = `LP${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const nonce = crypto.randomBytes(16).toString('base64');
        const baseURL = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://stain-bot-production-2593.up.railway.app';
        
        const requestBody = {
            amount: amount,
            currency: 'TWD',
            orderId: orderId,
            packages: [{
                id: orderId,
                amount: amount,
                name: 'C.H精緻洗衣服務',
                products: [{ name: '洗衣清潔費用', quantity: 1, price: amount }]
            }],
            redirectUrls: {
                confirmUrl: `${baseURL}/payment/linepay/confirm?orderId=${orderId}&userId=${userId}&userName=${encodeURIComponent(userName)}&amount=${amount}`,
                cancelUrl: `${baseURL}/payment/linepay/cancel`
            },
            // ✅ 新增這部分
            options: {
                payment: {
                   capture: true
                }
            }
        };
        
        const uri = '/v3/payments/request';
        const signature = generateLinePaySignature(uri, requestBody, nonce);
        
        logger.logToFile(`📤 LINE Pay 請求參數: ${JSON.stringify(requestBody, null, 2)}`);
        
        const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId,
                'X-LINE-Authorization-Nonce': nonce,
                'X-LINE-Authorization': signature
            },
            body: JSON.stringify(requestBody)
        });
        
        const result = await response.json();
        logger.logToFile(`📥 LINE Pay 回應: ${JSON.stringify(result, null, 2)}`);
       
        if (result.returnCode === '0000') {
            logger.logToFile(`✅ LINE Pay 付款請求成功: ${orderId}`);
            return { 
                success: true, 
                paymentUrl: result.info.paymentUrl.web, 
                orderId: orderId, 
                transactionId: result.info.transactionId 
            };
        } else {
            logger.logToFile(`❌ LINE Pay 付款請求失敗: ${result.returnCode} - ${result.returnMessage}`);
            return { 
                success: false, 
                error: `${result.returnMessage} (${result.returnCode})` 
            };
        }
    } catch (error) {
        logger.logError('LINE Pay 付款請求錯誤', error);
        return { 
            success: false, 
            error: error.message 
        };
    }
}

// 2️⃣ 修改 LINE Pay confirm 端點（約在第 315 行）
app.get('/payment/linepay/confirm', async (req, res) => {
    const { transactionId, orderId, userId, userName, amount } = req.query;
    
    logger.logToFile(`📥 收到 LINE Pay confirm 回調: transactionId=${transactionId}, orderId=${orderId}, userId=${userId}`);
    
    // ✅ 新增參數驗證
    if (!transactionId || !orderId || !userId || !amount) {
        logger.logToFile(`❌ LINE Pay confirm 參數不完整`);
        return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>參數錯誤</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>❌ 付款參數錯誤</h1><p>缺少必要參數，請重新嘗試</p></div></body></html>');
    }
    
    const order = orderManager.getOrder(orderId);
    
    if (order && orderManager.isExpired(orderId)) {
        const hoursPassed = (Date.now() - order.createdAt) / (1000 * 60 * 60);
        logger.logToFile(`❌ 訂單已過期: ${orderId} (已過 ${hoursPassed.toFixed(1)} 小時)`);
        return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>訂單已過期</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:linear-gradient(135deg,#f093fb,#f5576c);color:white}.container{background:rgba(255,255,255,0.1);border-radius:20px;padding:40px;max-width:500px;margin:0 auto}</style></head><body><div class="container"><h1>⏰ 訂單已過期</h1><p>此訂單已超過 7 天</p></div></body></html>');
    }
    
    try {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = `/v3/payments/${transactionId}/confirm`;
        const requestBody = { amount: parseInt(amount), currency: 'TWD' };
        const signature = generateLinePaySignature(uri, requestBody, nonce);
        
        // ✅ 新增詳細日誌
        logger.logToFile(`📤 LINE Pay confirm 請求: ${JSON.stringify(requestBody)}`);
        
        const response = await fetch(`${LINE_PAY_CONFIG.apiUrl}${uri}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-LINE-ChannelId': LINE_PAY_CONFIG.channelId, 
                'X-LINE-Authorization-Nonce': nonce, 
                'X-LINE-Authorization': signature 
            },
            body: JSON.stringify(requestBody)
        });
        
        const result = await response.json();
        
        // ✅ 新增詳細日誌
        logger.logToFile(`📥 LINE Pay confirm 回應: ${JSON.stringify(result, null, 2)}`);
        
        if (result.returnCode === '0000') {
            if (order) {
                orderManager.updateOrderStatus(orderId, 'paid', 'LINE Pay');
            }
            
            const updated = orderManager.updateOrderStatusByUserId(userId, 'paid', 'LINE Pay');
            logger.logToFile(`✅ LINE Pay 付款成功,已標記 ${updated} 筆訂單為已付款`);
            
            const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
            if (ADMIN_USER_ID) {
                await client.pushMessage(ADMIN_USER_ID, { 
                    type: 'text', 
                    text: `🎉 收到 LINE Pay 付款通知\n\n客戶姓名:${decodeURIComponent(userName)}\n付款金額:NT$ ${parseInt(amount).toLocaleString()}\n付款方式:LINE Pay\n訂單編號:${orderId}\n交易編號:${transactionId}\n\n狀態:✅ 付款成功` 
                });
            }
            
            if (userId && userId !== 'undefined') {
                await client.pushMessage(userId, { 
                    type: 'text', 
                    text: `✅ LINE Pay 付款成功\n\n感謝 ${decodeURIComponent(userName)} 的支付\n金額:NT$ ${parseInt(amount).toLocaleString()}\n訂單編號:${orderId}\n\n非常謝謝您\n感謝您的支持 💙` 
                });
            }
            
            logger.logToFile(`✅ LINE Pay 付款成功: ${decodeURIComponent(userName)} - ${amount}元`);
            res.redirect('/payment/success');
        } else {
            logger.logToFile(`❌ LINE Pay 付款確認失敗: ${result.returnCode} - ${result.returnMessage}`);
            res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>付款失敗</title><style>body{font-family:sans-serif;text-align:center;padding:50px}h1{color:#e74c3c}</style></head><body><h1>❌ 付款失敗</h1><p>' + result.returnMessage + '</p><p>請聯繫客服處理</p></body></html>');
        }
    } catch (error) {
        logger.logError('LINE Pay 確認付款失敗', error);
        res.status(500).send('付款處理失敗');
    }
});

// 3️⃣ 確保 LINE Pay 配置正確（檢查是否在代碼最上方）
const LINE_PAY_CONFIG = {
    channelId: process.env.LINE_PAY_CHANNEL_ID,
    channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
    env: process.env.LINE_PAY_ENV || 'production',
    apiUrl: process.env.LINE_PAY_ENV === 'sandbox' 
        ? 'https://sandbox-api-pay.line.me' 
        : 'https://api-pay.line.me'
};

// 4️⃣ generateLinePaySignature 函數保持不變（確認無誤）
function generateLinePaySignature(uri, body, nonce) {
    const message = LINE_PAY_CONFIG.channelSecret + uri + JSON.stringify(body) + nonce;
    return crypto.createHmac('SHA256', LINE_PAY_CONFIG.channelSecret)
        .update(message)
        .digest('base64');
}
