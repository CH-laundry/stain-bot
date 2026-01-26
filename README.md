# C.H 精緻洗衣 LINE Bot + MCP Server

洗衣服務 LINE 機器人，整合 MCP Server 自動連接洗衣管理系統。

## 專案功能

### LINE Bot 功能
- 🤖 AI 客服（使用 Claude）
- 🖼️ 污漬辨識（圖片上傳分析）
- 💳 付款整合（ECPay + LINE Pay）
- 📊 Google Sheets 客戶資料管理
- 🔔 自動通知與提醒

### MCP Server 功能
- 🔍 查詢收衣訂單列表
- 📋 查詢訂單詳細資料
- ✅ 更新配送狀態
- 🚚 查詢配送資訊

## 安裝步驟

### 1. 安裝依賴
```bash
npm install
```

### 2. 設定環境變數

建立 `.env` 檔案：
```env
# LINE Bot 設定
LINE_CHANNEL_ACCESS_TOKEN=你的LINE_TOKEN
LINE_CHANNEL_SECRET=你的LINE_SECRET

# Claude API
ANTHROPIC_API_KEY=你的CLAUDE_KEY

# C.H 洗衣系統 API
LAUNDRY_API_BASE_URL=http://lk2.ao-lan.cn
LAUNDRY_AUTH_TOKEN=你的洗衣系統TOKEN

# Google Sheets
GOOGLE_SHEETS_ID=你的SHEETS_ID
```

### 3. 啟動服務
```bash
# 啟動 LINE Bot
npm start

# 啟動 MCP Server
npm run mcp:start

# 開發模式（自動重啟）
npm run dev
```

## 專案結構
```
laundry-line-bot/
├── package.json          # 專案配置
├── index.js             # LINE Bot 主程式
├── .env                 # 環境變數（不要上傳到 Git）
├── src/
│   └── mcp/            # MCP Server
│       ├── index.js    # MCP 主程式
│       └── laundry-api.js  # 洗衣系統 API 客戶端
├── scripts/            # 工具腳本
│   ├── inspectStorage.js
│   └── writeTest.js
└── README.md           # 專案說明（本檔案）
```

## 使用說明

### LINE Bot 使用

客戶可以透過 LINE 與機器人對話：
- 詢問訂單狀態
- 上傳衣物照片辨識污漬
- 預約取衣時間
- 付款

### MCP Server 使用

AI 助手可以透過 MCP 自動操作洗衣系統：

**範例 1：查詢今日訂單**
```
使用者：「今天有哪些收衣訂單？」
AI 調用：get_orders_list()
回應：顯示今日訂單列表
```

**範例 2：查詢訂單詳細**
```
使用者：「訂單 001006160 的詳細資料」
AI 調用：get_order_detail("10af3c62-0fb7-400c...")
回應：顯示客戶資料、衣物明細、金額
```

**範例 3：標記已取件**
```
使用者：「客戶已取件，更新訂單狀態」
AI 調用：update_delivery_status("9b86d233-2520...")
回應：狀態已更新為「已簽收」
```

## 可用指令
```bash
npm start              # 啟動 LINE Bot
npm run dev           # 開發模式
npm run mcp:start     # 啟動 MCP Server
npm run pickup:track  # 取件追蹤
npm run pickup:watch  # 自動監控取件
```

## 部署

### 部署到 Railway

1. 推送程式碼到 GitHub
2. 在 Railway 連接 GitHub 倉庫
3. 設定環境變數
4. 自動部署

### 環境變數設定

在 Railway 設定以下環境變數：
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `ANTHROPIC_API_KEY`
- `LAUNDRY_API_BASE_URL`
- `LAUNDRY_AUTH_TOKEN`
- `GOOGLE_SHEETS_ID`

## 注意事項

⚠️ **Token 過期問題**

洗衣系統的 Authorization Token 會過期。過期後需要：
1. 使用 Fiddler 重新抓取新 Token
2. 更新 `.env` 的 `LAUNDRY_AUTH_TOKEN`
3. 重新部署

⚠️ **安全性**

- ❌ 不要將 `.env` 上傳到 GitHub
- ✅ 將 `.env` 加入 `.gitignore`
- ✅ 定期更換 API Token

## 開發團隊

C.H 精緻洗衣技術團隊

## 授權

MIT License

---

## 更新日誌

### v1.0.0 (2026-01-26)
- ✅ 整合 MCP Server
- ✅ 連接洗衣管理系統 API
- ✅ 支援訂單查詢與狀態更新
- ✅ LINE Bot AI 客服功能
