<script>
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

    // 可在這裡加載完畢後的 callback
    console.log('Agents loaded:', files);
  } catch (e) {
    console.error('載入 agents 失敗：', e);
  }
})();
</script>
