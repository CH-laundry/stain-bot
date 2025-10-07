// getRefreshToken.js
const http = require('http');
const url = require('url');
const querystring = require('querystring');
require('dotenv').config();

const CONFIG = {
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uri: process.env.GOOGLE_REDIRECT_URI, // 必須與 GCP 的 Authorized redirect URIs 完全一致
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ]
};

// 啟動前做基本檢查
(function sanityCheck() {
  const miss = [];
  if (!CONFIG.client_id) miss.push('GOOGLE_CLIENT_ID');
  if (!CONFIG.client_secret) miss.push('GOOGLE_CLIENT_SECRET');
  if (!CONFIG.redirect_uri) miss.push('GOOGLE_REDIRECT_URI');
  if (miss.length) {
    console.error('❌ .env 缺少：', miss.join(', '));
    process.exit(1);
  }
  if (!/^http:\/\/localhost:3000\/oauth2callback/.test(CONFIG.redirect_uri)) {
    console.warn('⚠️ 建議 redirect_uri 使用 http://localhost:3000/oauth2callback，並在 GCP 加入同樣一條 URI');
  }
})();

function generateAuthUrl() {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify({
    client_id: CONFIG.client_id,
    redirect_uri: CONFIG.redirect_uri,
    response_type: 'code',
    scope: CONFIG.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });
  return authUrl;
}

async function exchangeCodeForToken(code) {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const params = querystring.stringify({
    code,
    client_id: CONFIG.client_id,
    client_secret: CONFIG.client_secret,
    redirect_uri: CONFIG.redirect_uri,
    grant_type: 'authorization_code'
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: params
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('❌ Google 回應錯誤：', res.status, text);
    throw new Error('token exchange failed');
  }
  return JSON.parse(text);
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const { pathname, query } = url.parse(req.url, true);

    if (pathname === '/' || pathname === '') {
      const authUrl = generateAuthUrl();
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<h3>Google OAuth</h3><a href="${authUrl}" target="_blank">點我授權</a><pre>client_id: ${CONFIG.client_id}\nredirect_uri: ${CONFIG.redirect_uri}</pre>`);
    }

    if (pathname && pathname.startsWith('/oauth2callback')) {
      try {
        const code = query.code;
        if (!code) throw new Error('missing code');
        console.log('✅ 收到授權碼，開始交換 token…');
        const tokens = await exchangeCodeForToken(code);
        console.log('\n🎉 取得 Refresh Token：', tokens.refresh_token);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end('<h3>✅ 授權成功，請回終端機複製 refresh token</h3>');
        setTimeout(() => { server.close(); process.exit(0); }, 1500);
      } catch (e) {
        res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
        res.end('授權失敗，詳見終端機（多半是 client_id/client_secret/redirect_uri 不一致）');
      }
      return;
    }

    res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not Found');
  });

  server.listen(3000, () => {
    console.log('🚀 http://localhost:3000 已啟動');
    console.log('（頁面會顯示當前使用的 client_id / redirect_uri，用來比對 GCP 設定）');
  });
}

startServer();
