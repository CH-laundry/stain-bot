const { google } = require("googleapis");
const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "../applied-pager-449804-c6-a6aa3340d8da.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const SPREADSHEET_ID = "1GWa1f7pD4YN6bFGRtIGs7EfXIRw8vO0KPKH8Ti8DhHM";
const SHEET_NAME = "C.H FAQ 自動回覆";

async function fetchFAQFromSheet() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:B`,
  });

  const rows = res.data.values || [];
  return rows
    .filter(row => row[0] && row[1])
    .map(row => ({
      keywords: row[0],
      answer: row[1]
    }));
}

module.exports = { fetchFAQFromSheet };
