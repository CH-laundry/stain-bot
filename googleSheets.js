// googleSheets.js
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "未學問題記錄";

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "credentials.json"), // 這是你剛剛上傳的 JSON 金鑰檔案
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// 寫入「未學問題記錄」分頁
async function recordUnansweredQuestion(question, userId) {
  const sheets = await getSheetsClient();
  const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:C1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[question, userId, now]],
    },
  });

  console.log(`✅ 已記錄新問題：「${question}」`);
}

module.exports = { recordUnansweredQuestion };
