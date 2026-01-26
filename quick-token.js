const https = require('https');
const querystring = require('querystring');
const fs = require('fs');

const code = '4/0ASc3gC0EPHIKp_5AkrQc_P8lAgldE65pECdfIURkj1yLJBPx_B9trVMtKD4ipAPirP0kFQQ';
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const {client_secret, client_id, redirect_uris} = credentials.web;

const data = querystring.stringify({
  code: code,
  client_id: client_id,
  client_secret: client_secret,
  redirect_uri: redirect_uris[1],
  grant_type: 'authorization_code'
});

const options = {
  hostname: 'oauth2.googleapis.com',
  path: '/token',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      fs.writeFileSync('token.json', body);
      console.log('✅ Token 已儲存到 token.json');
      console.log(body);
    } else {
      console.error('❌ 錯誤:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ 請求失敗:', e);
});

req.write(data);
req.end();
