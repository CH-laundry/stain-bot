import requests

# ✅ 你的 LINE Bot 的 Access Token
ACCESS_TOKEN = " kq+xS02OJk/Plk+qe35We60WA18JMNWviOhu0+OAnHa18lHy4bqa1x6MK3QgnJFAulAcB0jjzPdD/bFAhoEFJl3jal5LO4Jio3Mn706AKJ8e4Bv6IfXlOJz//1E4l/LMRT7Z3iSMV0yJr4zEIkKQtAdB04t89/1O/w1cDnyilFU="

# ✅ 使用 Webhook 事件回傳的 replyToken（請填入你的值）
REPLY_TOKEN = "abc123def456ghi789"  # 這裡請填入你最新的 replyToken！

def reply_message(reply_token, text):
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "replyToken": reply_token,
        "messages": [
            {
                "type": "text",
                "text": text
            }
        ]
    }

    response = requests.post(url, json=payload, headers=headers)
    print("回應狀態碼:", response.status_code)
    print("回應內容:", response.json())

# 🚀 測試發送回覆訊息
reply_message(REPLY_TOKEN, "你好！這是機器人的回應！")
