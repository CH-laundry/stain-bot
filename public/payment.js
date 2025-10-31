// public/payment.js

async function loadCustomers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    const list = document.getElementById('customer-list');
    list.innerHTML = '';
    data.users.forEach(user => {
      const div = document.createElement('div');
      div.textContent = `${user.userName} (${user.userId})`;
      div.style.margin = '4px 0';
      list.appendChild(div);
    });
  } catch (err) {
    console.error('載入客戶失敗:', err);
  }
}

async function saveUserId(userId, userName) {
  if (!userId.startsWith('U')) {
    alert('User ID 必須以 U 開頭');
    return;
  }
  localStorage.setItem('savedUserId', userId);
  localStorage.setItem('savedUserName', userName);

  try {
    const res = await fetch(`/api/user/${userId}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: userName })
    });
    const data = await res.json();
    if (data.success) {
      alert('User ID 已儲存到伺服器');
      loadCustomers();
    } else {
      alert('儲存失敗: ' + data.error);
    }
  } catch (err) {
    console.error('儲存 User ID 失敗:', err);
    alert('儲存失敗');
  }
}

async function sendPayment() {
  const userId = localStorage.getItem('savedUserId');
  const userName = localStorage.getItem('savedUserName');
  const amountInput = document.getElementById('amount');
  const amount = amountInput ? parseInt(amountInput.value) : 0;

  if (!userId || !amount || amount <= 0) {
    alert('請先儲存 User ID 並輸入正確金額');
    return;
  }

  try {
    const res = await fetch('/send-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, userName, amount, paymentType: 'ecpay' })
    });
    const data = await res.json();
    if (data.success) {
      alert('支付連結已成功發送給客戶！');
      amountInput.value = '';
    } else {
      alert('發送失敗: ' + data.error);
    }
  } catch (err) {
    console.error('發送失敗:', err);
    alert('發送失敗');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadCustomers();

  document.getElementById('save-user')?.addEventListener('click', () => {
    const userId = document.getElementById('user-id-input').value.trim();
    const userName = document.getElementById('user-name-input').value.trim() || '未知客戶';
    if (userId) saveUserId(userId, userName);
  });

  document.getElementById('send-payment')?.addEventListener('click', sendPayment);
});
