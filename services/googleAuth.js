const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Token 儲存路徑
const TOKEN_PATH = path.join(__dirname, '../token.json');

// OAuth2 客戶端
let oauth2Client = null;

/**
 * 初始化 OAuth2 客戶端
 */
function getOAuth2Client() {
    if (oauth2Client) return oauth2Client;
    
    // ⭐ 優先使用環境變數 (Railway 生產環境)
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        console.log('✅ 使用環境變數初始化 Google OAuth');
        
        oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI || 'https://stain-bot-production-2593.up.railway.app/oauth2callback'
        );
    } 
    // ⭐ 如果沒有環境變數,才使用 credentials.json (本地開發)
    else {
        console.log('⚠️ 環境變數未設定,使用 credentials.json');
        
        const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
        
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            throw new Error('❌ 找不到 Google OAuth 憑證!請設定環境變數或建立 credentials.json');
        }
        
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
        const { client_id, client_secret, redirect_uris } = credentials.web;
        
        oauth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris[0]
        );
    }
    
    // 如果已有 token,載入它
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        oauth2Client.setCredentials(token);
        console.log('✅ 已載入 token');
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
    console.log('✅ Token 已儲存');
    
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
```

---

## 📄 更新 .gitignore

**確保 `.gitignore` 包含這些行:**
```
# 敏感憑證檔案
credentials.json
token.json

# Node modules
node_modules/

# Environment variables
.env

# Logs
*.log
logs/

# Railway
.railway/
