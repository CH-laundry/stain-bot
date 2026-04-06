// customerDatabase.js

// 這裡填入 LINE User ID 對應 客戶編號
// 你可以在 LINE Developers 後台或是 log 裡看到客人的 User ID
const customers = {
    "U5099169723d6e83588c5f23dfaf6f9cf": { // 把這個換成你測試帳號的 LINE ID
        realName: "625",  // 對應到洗衣軟體的編號
        displayName: "小林王子大大"
    },
    // 可以新增更多...
};

function getCustomer(userId) {
    return customers[userId] || null;
}

module.exports = { getCustomer };
