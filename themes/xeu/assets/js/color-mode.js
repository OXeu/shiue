(() => {
  let preference = 'auto';
  try {
    const stored = localStorage.getItem('xeu-color-mode');
    if (['light', 'dark', 'auto'].includes(stored)) preference = stored;
  } catch { /* 存储不可用时仍跟随系统。 */ }
  document.documentElement.dataset.colorPreference = preference;
  document.documentElement.dataset.colorMode = preference === 'auto'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference;
})();
