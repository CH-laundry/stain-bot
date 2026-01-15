const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
const TOKEN_DIR = '/data';
const TOKEN_PATH = path.join(TOKEN_DIR, 'google-token.json');

let oauth2Client = null;

function getOAuth2Client() {
    if (oauth2Client) return oauth2Client;
    
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_id, client_secret } = credentials.web;
    
    // ✅ 改這裡:用環境變數
    oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        process.env.GOOGLE_REDIRECT_URI || 'https://stain-bot-production-2593.up.railway.app/oauth2callback'
    );
    
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

async function getTokenFromCode(code) {
    const oauth2Client = getOAuth2Client();
    
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    try {
        if (!fs.existsSync(TOKEN_DIR)) {
            fs.mkdirSync(TOKEN_DIR, { recursive: true });
        }
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
        console.log('✅ Token 已儲存到:', TOKEN_PATH);
        
        if (fs.existsSync(TOKEN_PATH)) {
            console.log('✅ 驗證成功: Token 檔案已存在');
        }
    } catch (error) {
        console.error('❌ 儲存 token 失敗:', error.message);
    }
    
    return tokens;
}

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
