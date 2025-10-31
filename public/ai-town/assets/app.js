// assets/app.js
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const chatLog = $('#chatLog');
  const agentTitle = $('#agentTitle');
  const agentDesc = $('#agentDesc');
  const statusDot = $('#statusDot');
  const composer = $('#composer');
  const userInput = $('#userInput');
  const agentListEl = $('#agentList');

  let currentAgent = null;

  // ===== 角色清單渲染 =====
  function renderAgents() {
    agentListEl.innerHTML = '';
    AITOWN.AGENTS.forEach(a => {
      const item = document.createElement('div');
      item.className = 'agent';
      item.dataset.agent = a.id;
      item.innerHTML = `
        <div class="avatar">${a.emoji}</div>
        <div>
          <div class="title">${a.name}</div>
          <div class="subtitle">${a.desc}</div>
        </div>
      `;
      item.addEventListener('click', () => selectAgent(a.id));
      agentListEl.appendChild(item);
    });
  }

  function selectAgent(id) {
    currentAgent = AITOWN.AGENTS.find(x => x.id === id);
    $$('.agent').forEach(el => el.classList.toggle('active', el.dataset.agent === id));
    agentTitle.textContent = currentAgent.name;
    agentDesc.textContent = currentAgent.desc;
    pushBot(`您好，我是「${currentAgent.name}」。請描述您的需求或上傳照片，我先幫您評估～`);
  }

  // ===== 訊息渲染 =====
  function pushUser(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg me';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function pushBot(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

  // ===== 前端規則回覆（可立即使用）=====
  function replyByRules(text) {
    if (!currentAgent) {
      return '請先在左側選擇一位角色（例如：小C.H客服、清潔師傅）。';
    }
    // 角色內規則優先
    for (const rule of (currentAgent.rules || [])) {
      if (rule.test.test(text)) return rule.reply;
    }
    // 通用兜底（避免亂回：只針對常見洗衣關鍵字）
    const maybeLaundry = /(洗|清洗|清潔|去污|污|汙|發霉|泛黃|掉色|衣|鞋|包|窗簾|地毯|到府|收件|取件)/;
    if (!maybeLaundry.test(text)) {
      return '我目前只回覆與洗衣、洗鞋、洗包、到府收送相關的問題喔 🙏';
    }
    return '我了解～請告訴我「品項 + 材質 + 問題描述（例如：帆布包發霉、皮鞋有黃斑）」與是否急件，我會依情況給建議。';
  }

  // =====（預留）改成呼叫你後端的 AI 回覆 =====
  async function replyViaAPI(text) {
    // 之後要接你現有後端（例如 /api/ai-town/chat），把這段打開就好：
    // const res = await fetch('/api/ai-town/chat', {
    //   method:'POST', headers:{'Content-Type':'application/json'},
    //   body: JSON.stringify({ agent: currentAgent?.id, text })
    // });
    // const data = await res.json();
    // return data.reply || '（無回覆）';
    return replyByRules(text); // 目前先用前端規則
  }

  // ===== 事件：送出訊息 =====
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = userInput.value.trim();
    if (!text) return;
    pushUser(text);
    userInput.value = '';
    status('thinking');

    try {
      const reply = await replyViaAPI(text);
      pushBot(reply);
    } catch (err) {
      pushBot('服務暫時忙線中，請稍後再試 🙏');
      console.error(err);
    } finally {
      status('ready');
    }
  });

  // ===== 快速動作 =====
  $$('.qa').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.qa;
      const text = (AITOWN.QUICK && AITOWN.QUICK[key]) || '';
      if (text) {
        userInput.value = text;
        composer.requestSubmit();
      }
    });
  });

  // ===== 導覽按鈕 =====
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.action;
      if (act === 'entry') {
        // 回入口（保留 query/hash）
        const q = location.search || ''; const h = location.hash || '';
        location.href = '../portal/ai-town/ai-town-entry.html' + q + h;
      } else if (act === 'progress') {
        // 你已提供的 LIFF 進度網址
        window.open('https://liff.line.me/2004612704-JnzA1qN6', '_blank');
      } else if (act === 'pickup') {
        pushBot('請直接輸入完整地址與可收件時間（例如：新北市板橋區華江八路6號，明天 14:00–16:00）。我們會安排收件。');
      } else if (act === 'price') {
        pushBot('價目與儲值優惠：衣物 / 鞋 / 包 / 窗簾 / 地毯… 請告訴我品項，我幫您用最省方案。');
      }
    });
  });

  function status(state){
    // ready / thinking
    statusDot.style.background = (state === 'thinking') ? '#f59e0b' : '#10b981';
    statusDot.title = state;
  }

  // 初始化
  renderAgents();
})();
