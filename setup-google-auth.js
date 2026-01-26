const fs = require('fs'); 
const readline = require('readline'); 
const {google} = require('googleapis'); 
 
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']; 
const TOKEN_PATH = 'token.json'; 
const CREDENTIALS_PATH = 'credentials.json'; 
 
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)); 
const {client_secret, client_id, redirect_uris} = credentials.web; 
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[1]); 
 
const authUrl = oAuth2Client.generateAuthUrl({access_type: 'offline', scope: SCOPES, prompt: 'consent'}); 
console.log('請在瀏覽器打開此網址進行授權:'); 
console.log(authUrl); 
console.log('\n授權後,請輸入授權碼:'); 
 
const rl = readline.createInterface({input: process.stdin, output: process.stdout}); 
rl.question('授權碼: ', (code) => { 
  oAuth2Client.getToken(code, (err, token) => { 
    if (err) return console.error('取得 token 失敗', err); 
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token)); 
    console.log('Token 已儲存到', TOKEN_PATH); 
    rl.close(); 
  }); 
}); 
