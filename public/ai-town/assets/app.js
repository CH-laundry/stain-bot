// public/ai-town/assets/app.js
(function main(){
  // 防止重複初始化
  if (window.__AITOWN_BOOTED__) { console.warn('[AI-TOWN] already booted'); return; }
  window.__AITOWN_BOOTED__ = true;

  if (!window.AITOWN || !Array.isArray(window.AITOWN.AGENTS)) {
    alert('找不到角色資料（agents.js 未載入或路徑錯誤）。請確認 ./assets/agents.js 是否存在且先於 app.js 載入。');
    console.error('[AI-TOWN] AITOWN.AGENTS is missing.'); return;
  }

  // === 開關 ===
  const SHOW_GREETING = false;           // 關閉首次招呼語
  const STRICT_KEYWORD_ONLY = true;      // ? 只命中關鍵字才回覆；沒命中時完全不回

  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const chatLog   = $('#chatLog');
  const agentList = $('#agentList');
  const agentTitle= $('#agentTitle');
  const agentDesc = $('#agentDesc');
  const statusDot = $('#statusDot');
  const composer  = $('#composer');
  const userInput = $('#userInput');

  let currentAgent = null;

  // 渲染左側角色
  function renderAgents(){
    agentList.innerHTML = '';
    window.AITOWN.AGENTS.forEach(a=>{
      const item = document.createElement('div');
      item.className = 'agent';
      item.dataset.agent = a.id;
      item.innerHTML = `
        <div class="avatar">${a.emoji}</div>
        <div>
          <div class="title">${a.name}</div>
          <div class="subtitle">${a.desc}</div>
        </div>`;
      item.addEventListener('click', ()=> selectAgent(a.id));
      agentList.appendChild(item);
    });
  }

  function selectAgent(id){
    currentAgent = window.AITOWN.AGENTS.find(x=>x.id===id);
    $$('.agent').forEach(el=> el.classList.toggle('active', el.dataset.agent===id));
    agentTitle.textContent = currentAgent.name;
    agentDesc.textContent  = currentAgent.desc;

    // 不打招呼（SHOW_GREETING=false）
    if (SHOW_GREETING) {
      pushBot(`您好，我是「${currentAgent.name}」。請描述您的需求或上傳照片，我先幫您評估～`);
    }
  }

  // 訊息 UI
  function pushUser(t){ appendMsg('me', t); }
  function pushBot(t){ appendMsg('bot', t); }
  function appendMsg(who, text){
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (who==='me' ? ' me' : '');
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

  // ? 嚴格關鍵字模式：只要沒命中規則 → 回傳 null（外層就不發訊息）
  function replyByRules(text){
    if (!currentAgent) return null;
    const rules = currentAgent.rules || [];
    for (const r of rules) {
      if (r.test.test(text)) return r.reply;
    }
    // 沒命中任何關鍵字
    if (STRICT_KEYWORD_ONLY) return null;

    // （非嚴格模式才會走到這裡的預設引導）
    const maybeLaundry = /(洗|清洗|清潔|去污|污|汙|發霉|泛黃|掉色|衣|鞋|包|窗簾|地毯|到府|收件|取件)/;
    if (!maybeLaundry.test(text)) return '我目前只回覆與洗衣、洗鞋、洗包、到府收送相關的問題喔 ??';
    return '請提供「品項 + 材質 + 問題描述（例如：帆布包發霉、皮鞋有黃斑）」與是否急件，我會依情況給建議。';
  }

  // 之後要接後端 AI 時，只改這個函式
  async function replyViaAPI(text){
    return replyByRules(text); // 嚴格模式下，命中→字串；未命中→null
  }

  // 送出處理
  composer.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const text = userInput.value.trim();
    if (!text) return;
    pushUser(text);
    userInput.value = '';
    setStatus('thinking');
    try{
      const resp = await replyViaAPI(text);
      // ? 嚴格模式：未命中關鍵字 → 不回覆（直接靜默）
      if (resp && resp.trim()) pushBot(resp.trim());
    }catch(err){
      console.error(err);
      // 嚴格模式也避免雜訊：只在真的錯誤時給系統提示
      pushBot('系統繁忙，請稍後再試 ??');
    }finally{
      setStatus('ready');
    }
  });

  // 快速動作：會自帶明確關鍵字，必定命中規則
  $$('.qa').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.qa;
      const t = (window.AITOWN.QUICK && window.AITOWN.QUICK[key]) || '';
      if (t){
        userInput.value = t;
        composer.requestSubmit();
      }
    });
  });

  // 導覽按鈕（不影響關鍵字模式）
  $$('.nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const act = btn.dataset.action;
      if (act==='entry'){
        const q = location.search || '', h = location.hash || '';
        location.href = '../portal/ai-town/ai-town-entry.html' + q + h;
      }else if (act==='progress'){
        window.open('https://liff.line.me/2004612704-JnzA1qN6','_blank');
      }else if (act==='pickup'){
        // 在嚴格模式下，這裡也不主動發長訊息，以免被當成非關鍵字回覆
        pushBot('請直接輸入：地址＋可收件時間（例如：新北市板橋區華江八路6號，明天14:00–16:00）');
      }else if (act==='price'){
        pushBot('請輸入：欲處理品項＋數量（例如：運動鞋 2 雙、窗簾 1 組），我回覆合適方案。');
      }
    });
  });

  function setStatus(s){
    statusDot.style.background = (s==='thinking') ? '#f59e0b' : '#10b981';
    statusDot.title = s;
  }

  renderAgents();
  console.log('[AI-TOWN] strict keyword mode =', STRICT_KEYWORD_ONLY, 'greeting =', SHOW_GREETING);
})();
