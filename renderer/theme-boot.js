'use strict';

// 主题启动自举。
// 主进程的 app-settings.json 是唯一事实来源，但设置读取是异步 IPC：
// 等它回来再上色，面板第一帧会先闪一下经典黑。所以先把上一次的主题同步
// 应用到 <html>，随后再由 pet-panel.js 用主进程返回值对账并回写缓存。
(function () {
  const CACHE_KEY = 'notch-theme-cache-v1';
  const theme = window.NotchTheme;

  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writeCache(value) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch (error) {
      // 隐私模式等写不进去就只影响下一帧，不影响本次换肤。
    }
  }

  // 返回实际生效的主题，调用方据此更新设置页选中态。
  // 主进程 settings:get 回传的键是 themePalette，本地缓存写的是 palette，
  // 两个都要认，否则启动对账会把照片主题误清回经典黑。
  function applyPayload(payload) {
    if (!theme) return { theme: 'classic', palette: null };
    const source = payload && typeof payload === 'object' ? payload : null;
    const palette = source ? (source.palette || source.themePalette) : null;
    if (source && source.theme === 'photo' && palette && theme.apply(palette, 'app')) {
      return { theme: 'photo', palette };
    }
    theme.clear();
    return { theme: 'classic', palette: null };
  }

  if (!theme) return;

  applyPayload(readCache());

  window.NotchThemeBoot = {
    CACHE_KEY,
    applyPayload,
    readCache,
    writeCache,
  };
})();
