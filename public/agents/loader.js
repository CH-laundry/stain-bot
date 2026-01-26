(async () => {
  try {
    const res = await fetch('/agents/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('manifest.json 載入失敗');
    const files = await res.json();
    if (!Array.isArray(files)) throw new Error('manifest 格式錯誤');

    for (const f of files) {
      const s = document.createElement('script');
      s.src = `/agents/${f}`;
      s.defer = true;
      document.head.appendChild(s);
    }

    console.log('✅ Agents loaded:', files);

    // ===============================
    // ✅ 顯示畫面提示 (不用開 F12 也能看到)
    // ===============================
    const tip = document.createElement('div');
    tip.textContent = '✅ C.H 精緻洗衣 AI 小鎮角色載入成功';
    Object.assign(tip.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      background: '#3B5F8F',
      color: '#fff',
      padding: '10px 16px',
      borderRadius: '8px',
      fontWeight: '600',
      boxShadow: '0 3px 10px rgba(0,0,0,0.2)',
      zIndex: '9999',
      fontFamily: 'Microsoft JhengHei',
      fontSize: '15px'
    });
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 4000);

    // ===============================
    // 🧩 額外偵錯功能（網址加上 ?debug=true 會顯示全部角色）
    // ===============================
    if (location.search.includes('debug=true')) {
      alert('已載入角色：\n' + files.join('\n'));
    }

  } catch (e) {
    console.error('🚫 載入 agents 失敗：', e);
    alert('🚫 載入失敗，請檢查 manifest.json 或檔名是否正確！');
  }
})();
