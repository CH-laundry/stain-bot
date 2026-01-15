const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 🔥 改成存到 /data (Railway Volume)
const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
const TOKEN_PATH = '/data/google-token.json';  // ✅ 改這裡!

// OAuth2 客戶端
let oauth2Client = null;

/**
 * 初始化 OAuth2 客戶端
 */
function getOAuth2Client() {
    if (oauth2Client) return oauth2Client;
    
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_id, client_secret, redirect_uris } = credentials.web;
    
    oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );
    
    // 如果已有 token,載入它
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            oauth2Client.setCredentials(token);
            console.log('✅ Google OAuth token 已載入');
        } catch (error) {
            console.error('❌ 載入 token 失敗:', error.message);
        }
    } else {
        console.log('⚠️ Token 檔案不存在:', TOKEN_PATH);
    }
    
    return oauth2Client;
}

/**
 * 生成授權 URL
 */
function getAuthUrl() {
    const oauth2Client = getOAuth2Client();
    
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ],
    });
    
    return authUrl;
}

/**
 * 處理授權碼,取得 token
 */
async function getTokenFromCode(code) {
    const oauth2Client = getOAuth2Client();
    
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // 🔥 儲存到 /data 確保持久化
    try {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
        console.log('✅ Token 已儲存到:', TOKEN_PATH);
    } catch (error) {
        console.error('❌ 儲存 token 失敗:', error.message);
    }
    
    return tokens;
}

/**
 * 檢查是否已授權
 */
function isAuthorized() {
    const exists = fs.existsSync(TOKEN_PATH);
    console.log('🔍 檢查授權狀態:', exists ? '已授權' : '未授權');
    return exists;
}

module.exports = {
    getOAuth2Client,
    getAuthUrl,
    getTokenFromCode,
    isAuthorized
};
