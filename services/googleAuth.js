const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 讀取憑證
const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
const TOKEN_PATH = path.join(__dirname, '../token.json');

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
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        oauth2Client.setCredentials(token);
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
        prompt: 'consent',  // ✅ 強制重新授權,取得完整權限
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
    
    // 儲存 token
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    
    return tokens;
}

/**
 * 檢查是否已授權
 */
function isAuthorized() {
    return fs.existsSync(TOKEN_PATH);
}

module.exports = {
    getOAuth2Client,
    getAuthUrl,
    getTokenFromCode,
    isAuthorized
};
