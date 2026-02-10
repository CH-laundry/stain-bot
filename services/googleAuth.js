const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 🔥 改成存到 /data (Railway Volume)
const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
const TOKEN_DIR = '/data';
const TOKEN_PATH = path.join(TOKEN_DIR, 'google-token.json');

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
            console.log('✅ Google OAuth token 已載入:', TOKEN_PATH);
            
            // 🔥🔥🔥 自動刷新 Token (新增) 🔥🔥🔥
            oauth2Client.on('tokens', (tokens) => {
                try {
                    console.log('🔄 Token 正在更新...');
                    
                    // 讀取現有 token
                    let savedToken = {};
                    if (fs.existsSync(TOKEN_PATH)) {
                        savedToken = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
                    }
                    
                    // 只在有新的 refresh_token 時更新
                    if (tokens.refresh_token) {
                        savedToken.refresh_token = tokens.refresh_token;
                        console.log('✅ 已更新 refresh_token');
                    }
                    
                    // 更新 access_token 和過期時間
                    savedToken.access_token = tokens.access_token;
                    savedToken.expiry_date = tokens.expiry_date;
                    savedToken.token_type = tokens.token_type || savedToken.token_type;
                    savedToken.scope = tokens.scope || savedToken.scope;
                    
                    // 儲存新的 token
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(savedToken, null, 2), 'utf8');
                    console.log('✅ Token 已自動更新並儲存');
                    
                    // 顯示過期時間
                    if (tokens.expiry_date) {
                        const expiryDate = new Date(tokens.expiry_date);
                        console.log('⏰ Token 有效期至:', expiryDate.toLocaleString('zh-TW'));
                    }
                    
                } catch (error) {
                    console.error('❌ Token 自動更新失敗:', error.message);
                }
            });
            // 🔥🔥🔥 結束 🔥🔥🔥
            
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
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/gmail.send'
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
    
    // 🔥 確保目錄存在
    try {
        if (!fs.existsSync(TOKEN_DIR)) {
            fs.mkdirSync(TOKEN_DIR, { recursive: true });
            console.log('✅ 建立目錄:', TOKEN_DIR);
        }
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
        console.log('✅ Token 已儲存到:', TOKEN_PATH);
        
        // 驗證檔案確實存在
        if (fs.existsSync(TOKEN_PATH)) {
            console.log('✅ 驗證成功: Token 檔案已存在');
            
            // 顯示過期時間
            if (tokens.expiry_date) {
                const expiryDate = new Date(tokens.expiry_date);
                console.log('⏰ Token 有效期至:', expiryDate.toLocaleString('zh-TW'));
            }
        } else {
            console.error('❌ 驗證失敗: Token 檔案不存在!');
        }
    } catch (error) {
        console.error('❌ 儲存 token 失敗:', error.message);
        console.error('完整錯誤:', error);
    }
    
    return tokens;
}

/**
 * 檢查是否已授權
 */
function isAuthorized() {
    const exists = fs.existsSync(TOKEN_PATH);
    console.log('🔍 檢查授權狀態:', exists ? '已授權' : '未授權', '路徑:', TOKEN_PATH);
    
    // 如果檔案存在,顯示檔案大小
    if (exists) {
        const stats = fs.statSync(TOKEN_PATH);
        console.log('📄 Token 檔案大小:', stats.size, 'bytes');
    }
    
    return exists;
}

module.exports = {
    getOAuth2Client,
    getAuthUrl,
    getTokenFromCode,
    isAuthorized
};
