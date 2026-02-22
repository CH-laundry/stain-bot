const { google } = require('googleapis');

// Service Account 客戶端 (永久授權，不會過期)
let serviceAccountClient = null;

/**
 * 初始化 Service Account 客戶端
 * 優先使用 GOOGLE_SERVICE_ACCOUNT 環境變數
 * 備用：GOOGLE_SHEETS_CREDENTIALS 或 GOOGLE_SHEETS_CREDS
 */
function getOAuth2Client() {
    if (serviceAccountClient) return serviceAccountClient;

    // 依序嘗試各個環境變數
    const rawCreds =
        process.env.GOOGLE_SERVICE_ACCOUNT ||
        process.env.GOOGLE_SHEETS_CREDENTIALS ||
        process.env.GOOGLE_SHEETS_CREDS ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!rawCreds) {
        throw new Error('❌ 找不到 Service Account 憑證！請確認 Railway 環境變數 GOOGLE_SERVICE_ACCOUNT 已設定');
    }

    let credentials;
    try {
        credentials = JSON.parse(rawCreds);
    } catch (e) {
        throw new Error('❌ Service Account 憑證 JSON 格式錯誤：' + e.message);
    }

    serviceAccountClient = new google.auth.GoogleAuth({
        credentials,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/gmail.send'
        ]
    });

    console.log('✅ Service Account 已初始化，永久有效');
    return serviceAccountClient;
}

/**
 * 檢查是否已授權
 * Service Account 只要環境變數存在就算授權，永遠回傳 true
 */
function isAuthorized() {
    const hasCreds =
        !!(process.env.GOOGLE_SERVICE_ACCOUNT ||
           process.env.GOOGLE_SHEETS_CREDENTIALS ||
           process.env.GOOGLE_SHEETS_CREDS ||
           process.env.GOOGLE_APPLICATION_CREDENTIALS);

    console.log('🔍 Service Account 授權狀態:', hasCreds ? '✅ 已授權' : '❌ 未授權');
    return hasCreds;
}

/**
 * 以下兩個函數保留介面相容性（OAuth 流程不再需要，但不移除以防其他地方有呼叫）
 */
function getAuthUrl() {
    console.warn('⚠️ 已改用 Service Account，不需要 OAuth 授權流程');
    return null;
}

async function getTokenFromCode(code) {
    console.warn('⚠️ 已改用 Service Account，不需要 OAuth Token');
    return null;
}

module.exports = {
    getOAuth2Client,
    getAuthUrl,
    getTokenFromCode,
    isAuthorized
};
