# 洗衣服务LINE聊天机器人

这是一个专为洗衣服务设计的LINE聊天机器人，能够自动回复客户的常见问题、处理收送衣物的请求、提供清洗进度查询等功能。机器人通过Google Sheets获取回复内容，支持动态回复和地址检测。

## 功能特点

- **地址检测**：自动识别用户名称中的地址信息，提供上门收送服务
- **动态收送回复**：根据当前时间、星期和地区动态安排收送时间
- **Google Sheets集成**：从Google Sheets读取关键词和回复内容，便于非技术人员更新
- **多种问题识别**：支持识别清洗进度查询、营业时间查询、清洗方式咨询等多种问题类型
- **智能过滤**：自动过滤与洗衣无关的消息，专注于业务相关对话

## 项目结构

```
洗衣服务LINE机器人/
├── index.js                # 主程序入口
├── addressDetector.js      # 地址检测模块
├── dynamicReply.js         # 动态回复处理模块
├── sheetsReply.js          # Google Sheets集成模块
├── keywordRules.js         # 关键词规则定义
├── test.js                 # 测试脚本
├── CH資料庫.xlsx           # 本地Excel数据库文件
├── package.json            # 项目依赖配置
├── .env                    # 环境变量配置
└── README.md               # 项目说明文档
```

## 技术栈

- **Node.js**: 运行环境
- **Express**: Web服务器框架
- **@line/bot-sdk**: LINE Messaging API SDK
- **ExcelJS**: Excel文件处理
- **Axios**: HTTP请求
- **Dayjs**: 日期时间处理
- **Dotenv**: 环境变量管理

## 安装指南

### 前提条件

- Node.js (v12.0.0 或更高版本)
- LINE 开发者账号
- Google Sheets API 密钥

### 安装步骤

1. 解压文件
2. 安装依赖

```bash
npm install
```

3. 配置环境变量
创建 `.env` 文件并填入以下信息：
```
# LINE Bot 配置
LINE_CHANNEL_ACCESS_TOKEN=你的LINE频道访问令牌
LINE_CHANNEL_SECRET=你的LINE频道密钥

# Google Sheets 配置
GOOGLE_SHEETS_ID=你的Google Sheets ID
SHEETS_API_KEY=你的Google Sheets API密钥
GOOGLE_CREDENTIALS_PATH=你的Google凭证JSON文件路径
GOOGLE_SHEETS_CREDS=你的Google凭证JSON文件路径
SHEET_ID=你的Google Sheets ID

# OpenAI 配置（如果使用）
OPENAI_API_KEY=你的OpenAI API密钥
OPENAI_PROJECT_ID=你的OpenAI项目ID
OPENAI_ORG_ID=你的OpenAI组织ID

# 使用限制配置
MAX_USES_PER_USER=2
MAX_USES_TIME_PERIOD=604800

# 管理员配置
ADMIN=管理员LINE用户ID1
ADMIN=管理员LINE用户ID2

# 服务器配置
PORT=3000
NODE_OPTIONS=--dns-result-order=ipv4first
REDIS_URL=你的Redis URL（如果使用）
NODE_ENV=production
```

4. 准备Excel数据库文件

确保 `CH資料庫.xlsx` 文件位于项目根目录，并包含正确的关键词和回复内容。

## 启动项目

### 本地开发环境

```bash
npm run dev
```

这将使用nodemon启动服务器，当代码变更时自动重启。

### 生产环境

```bash
npm start
```

服务器将在 http://localhost:3000 启动（或在.env文件中指定的端口）。

### 使用PM2进行生产部署（推荐）

```bash
npm install -g pm2
pm2 start index.js --name "laundry-line-bot"
```

## 测试

项目包含一个测试脚本，可以模拟用户发送消息并测试机器人的回复：

```bash
node test.js
```

## 功能说明

### 地址检测

机器人能够识别用户名称中的地址信息，当用户请求送回衣物时，会自动提取地址并确认收送服务。

### 动态收送回复

根据以下条件动态安排收送时间：
- 如果用户提到"后天"，安排后天收送
- 如果用户提到"明天"，安排明天收送
- 如果当天是周六，安排明天收送（周六公休）
- 如果用户在特定地区（三重、新莊、土城等）或当前时间晚于17点，安排明天收送
- 其他情况安排当天收送

### Google Sheets集成

机器人从Google Sheets读取关键词和回复内容，支持以下问题类型：
- 清洗进度查询
- 营业时间查询
- 清洗方式咨询
- 婴儿用品清洗咨询
- 清洁时间查询

### 关键词规则

除了Google Sheets中的规则外，机器人还支持在`keywordRules.js`中定义的关键词规则，可以根据需要进行扩展。

## 维护与更新

### 更新回复内容

非技术人员可以直接编辑Google Sheets文档来更新关键词和回复内容，无需修改代码。

### 添加新功能

1. 在相应的模块中添加新功能
2. 在`index.js`的`handleMessage`函数中集成新功能
3. 更新测试脚本以测试新功能

## 故障排除

### Webhook验证失败

- 确保Webhook URL是HTTPS的
- 检查Channel Secret是否正确
- 确保服务器防火墙允许LINE平台的请求

### 消息未收到回复

- 检查终端日志是否有错误信息
- 验证关键词匹配规则是否正确
- 确认Google Sheets数据是否正确加载

### Google Sheets连接问题

- 检查API密钥是否有效
- 确认Sheets ID是否正确
- 验证Sheets权限设置

## 功能测试

以下是一系列测试命令，可用于演示和验证机器人的各项功能。这些测试涵盖了机器人的核心功能。

### 基础功能测试

1. **启动服务**
```bash
# 启动LINE机器人服务
node index.js

# 或使用PM2启动（生产环境推荐）
pm2 start index.js --name "laundry-line-bot"
```

2. **运行测试脚本**
```bash
# 运行完整测试脚本
node test.js
```

### 模块功能测试

1. **地址检测功能**
```bash
# 测试地址识别功能
node -e "const AddressDetector = require('./addressDetector'); console.log('地址检测结果:', AddressDetector.isAddress('台北市大安區和平東路二段106號')); console.log('回复格式化:', AddressDetector.formatResponse('台北市大安區和平東路二段106號'));"
```

2. **动态回复功能**
```bash
# 测试动态收送回复功能
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log('测试动态回复:', handleDynamicReceiving('我要送洗衣服，你们什么时候来收'));"

# 测试后天收送
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log('后天收送测试:', handleDynamicReceiving('后天可以来收衣服吗'));"

# 测试明天收送
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log('明天收送测试:', handleDynamicReceiving('明天可以来收衣服吗'));"

# 测试特定地区收送
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log('特定地区测试:', handleDynamicReceiving('我在三重，可以来收衣服吗'));"
```

3. **Google Sheets回复功能**
```bash
# 测试Sheets回复功能
node -e "const SheetsReply = require('./sheetsReply'); const sheetsReply = new SheetsReply(); async function test() { await sheetsReply.loadData(); console.log('营业时间查询:', sheetsReply.getReply('營業時間是幾點到幾點')); } test();"

# 测试清洗进度查询
node -e "const SheetsReply = require('./sheetsReply'); const sheetsReply = new SheetsReply(); async function test() { await sheetsReply.loadData(); console.log('清洗进度查询:', sheetsReply.getReply('我的衣服洗好了嗎')); } test();"

# 测试清洗方式查询
node -e "const SheetsReply = require('./sheetsReply'); const sheetsReply = new SheetsReply(); async function test() { await sheetsReply.loadData(); console.log('清洗方式查询:', sheetsReply.getReply('這件衣服可以水洗嗎')); } test();"
```

4. **关键词规则测试**
```bash
# 测试关键词规则匹配
node -e "const keywordRules = require('./keywordRules'); const text = '你们的价格是多少'; const matchedRule = keywordRules.find(rule => rule.keywords.some(keyword => text.includes(keyword))); console.log('关键词匹配结果:', matchedRule ? (typeof matchedRule.response === 'function' ? matchedRule.response(text) : matchedRule.response) : '无匹配规则');"
```


```

2. **测试Webhook响应**
```bash
# 模拟LINE平台发送消息到Webhook
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Line-Signature: 模拟签名" \
  -d '{
    "events": [
      {
        "type": "message",
        "replyToken": "test-reply-token",
        "source": {
          "userId": "test-user-id",
          "type": "user"
        },
        "message": {
          "type": "text",
          "text": "我要送洗衣服"
        }
      }
    ]
  }'
```

### 性能测试

1. **加载时间测试**
```bash
# 测试Google Sheets数据加载时间
time node -e "const SheetsReply = require('./sheetsReply'); const sheetsReply = new SheetsReply(); async function test() { console.time('加载时间'); await sheetsReply.loadData(); console.timeEnd('加载时间'); } test();"
```

2. **响应时间测试**
```bash
# 测试消息处理响应时间
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.time('响应时间'); const response = handleDynamicReceiving('我要送洗衣服，你们什么时候来收'); console.timeEnd('响应时间'); console.log(response);"
```

### 错误处理测试

1. **无效输入测试**
```bash
# 测试空消息处理
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log(handleDynamicReceiving(''));"

# 测试特殊字符处理
node -e "const { handleDynamicReceiving } = require('./dynamicReply'); console.log(handleDynamicReceiving('!@#$%^&*()'));"
```

2. **Excel文件缺失测试**
```bash
# 备份原文件
cp CH資料庫.xlsx CH資料庫.xlsx.bak

# 临时移除Excel文件
mv CH資料庫.xlsx CH資料庫.xlsx.temp

# 测试文件缺失情况
node -e "const SheetsReply = require('./sheetsReply'); const sheetsReply = new SheetsReply(); async function test() { try { await sheetsReply.loadData(); console.log('加载结果:', sheetsReply.qaData.length); } catch (error) { console.log('预期错误:', error.message); } } test();"

# 恢复文件
mv CH資料庫.xlsx.temp CH資料庫.xlsx
```

这些测试命令涵盖了机器人的各个功能模块和可能的使用场景。

## Webhook测试指南

为了测试LINE Bot的Webhook功能，我们提供了一个签名生成工具和详细的测试步骤。

### 签名生成工具

项目包含一个`generateSignature.js`脚本，用于生成LINE Webhook请求的签名：

```bash
# 运行签名生成工具
node generateSignature.js
```

这将输出：
- 完整的请求URL和方法
- 所需的请求头信息（包括签名）
- 请求体JSON

### Postman测试步骤

1. **准备工作**
   - 确保服务器正在运行 (`node index.js`)
   - 运行签名生成工具获取测试信息

2. **配置Postman请求**
   - Method: POST
   - URL: `http://localhost:3000/webhook`
   - Headers:
     ```
     Content-Type: application/json
     X-Line-Signature: {从生成工具获取的签名}
     ```
   - Body: 选择 "raw" 和 "JSON"，复制生成工具提供的JSON字符串

3. **注意事项**
   - 签名验证对JSON格式非常敏感，请使用生成工具提供的精确JSON字符串
   - 不要手动格式化JSON或更改空格
   - Headers的名称大小写必须完全匹配
   - 确保环境变量中的Channel Secret正确配置

### 测试场景

1. **收送衣物请求**
```json
{
  "events": [{
    "type": "message",
    "replyToken": "test-reply-token",
    "source": {
      "userId": "test-user-id",
      "type": "user"
    },
    "message": {
      "type": "text",
      "text": "我要送洗衣服，你们什么时候来收"
    }
  }]
}
```

2. **营业时间查询**
```json
{
  "events": [{
    "type": "message",
    "replyToken": "test-reply-token",
    "source": {
      "userId": "test-user-id",
      "type": "user"
    },
    "message": {
      "type": "text",
      "text": "營業時間是幾點到幾點"
    }
  }]
}
```

3. **地址检测**
```json
{
  "events": [{
    "type": "message",
    "replyToken": "test-reply-token",
    "source": {
      "userId": "test-user-id",
      "type": "user",
      "displayName": "台北市大安區和平東路二段106號"
    },
    "message": {
      "type": "text",
      "text": "请送回我的衣服"
    }
  }]
}
```

### 故障排除

1. **签名验证失败**
   - 检查Channel Secret是否正确配置
   - 确保使用了生成工具提供的精确JSON字符串
   - 验证Headers的名称和大小写是否正确

2. **服务器无响应**
   - 确认服务器正在运行
   - 检查端口3000是否被占用
   - 查看服务器日志是否有错误信息

3. **回复消息失败**
   - 检查Channel Access Token是否正确
   - 确认LINE Messaging API是否正常
   - 查看服务器日志中的详细错误信息
