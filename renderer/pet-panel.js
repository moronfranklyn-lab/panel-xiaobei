'use strict';

// 照片生成换肤与桌宠的渲染层接线。
// 桌面覆盖窗口（renderer/pet.js）只负责宠物本体与气泡；面板内的
// 外观卡片、桌宠设置卡片与「宠物」页都由本文件负责。
(function () {
  const api = window.notchAPI;
  if (!api) return;

  const theme = window.NotchTheme;
  const themeBoot = window.NotchThemeBoot;

  /* ==================== 元素 ==================== */
  const themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'));
  const themeReset = document.getElementById('settings-theme-reset');
  const themeChoose = document.getElementById('settings-theme-choose');
  const themeClear = document.getElementById('settings-theme-clear');
  const themePreview = document.getElementById('settings-theme-photo-preview');
  const themeReport = document.getElementById('settings-theme-report');
  const photoSwatch = document.querySelector('[data-theme-swatch="photo"]');

  const petEnabled = document.getElementById('settings-pet-enabled');
  const petSizeButtons = Array.from(document.querySelectorAll('[data-pet-size]'));

  const chatLog = document.getElementById('pet-chat-log');
  const chatForm = document.getElementById('pet-chat-form');
  const chatInput = document.getElementById('pet-chat-input');
  const chatSend = document.getElementById('pet-chat-send');
  const chatHint = document.getElementById('pet-chat-hint');
  const llmStatus = document.getElementById('pet-llm-status');
  const conversationClear = document.getElementById('pet-conversation-clear');
  const petDisable = document.getElementById('pet-disable');
  const memoryList = document.getElementById('pet-memory-list');
  const memoryForm = document.getElementById('pet-memory-form');
  const memoryInput = document.getElementById('pet-memory-input');
  const memoryClear = document.getElementById('pet-memory-clear');

  /* ==================== 状态 ==================== */
  let currentTheme = { theme: 'classic', palette: null };
  let currentSettings = null;
  let hasPhoto = false;
  let llmConfigured = false;
  let chatBusy = false;

  function notify(message) {
    if (typeof showStatusToast === 'function') showStatusToast(message);
  }

  /* ==================== 外观：主题卡片 ==================== */

  function swatchBackground(palette) {
    if (!palette) return '';
    return `linear-gradient(135deg, ${palette.bg} 0%, ${palette.surface2} 42%, ${palette.accent} 100%)`;
  }

  function renderReport(report) {
    if (!themeReport) return;
    if (!report) {
      themeReport.textContent = '选择一张照片，自动提取色板并保证正文对比度。';
      return;
    }
    const mode = report.mode === 'light' ? '浅色' : '深色';
    const read = (key) => {
      const value = Number(report[key]);
      return Number.isFinite(value) ? `${value.toFixed(2)}:1` : '—';
    };
    themeReport.textContent = `已生成${mode}主题 · 实测对比度 正文 ${read('text1/bg')} · 次级 ${read('text2/bg')} · 辅助 ${read('text3/bg')}`;
  }

  function renderTheme() {
    const isPhoto = currentTheme.theme === 'photo';
    for (const button of themeModeButtons) {
      const selected = button.dataset.themeMode === currentTheme.theme;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
    }
    if (photoSwatch) {
      const background = swatchBackground(currentTheme.palette);
      if (background) photoSwatch.style.background = background;
      else photoSwatch.style.removeProperty('background');
    }
    if (themeClear) themeClear.disabled = !hasPhoto;
    if (themeChoose) themeChoose.textContent = hasPhoto ? '更换照片…' : '选择照片…';
  }

  async function refreshPhotoPreview() {
    if (!api.getPhotoTheme) return;
    try {
      const result = await api.getPhotoTheme();
      const dataUrl = result && result.dataUrl;
      hasPhoto = Boolean(dataUrl);
      if (themePreview) {
        if (dataUrl) {
          themePreview.src = dataUrl;
          themePreview.hidden = false;
        } else {
          themePreview.removeAttribute('src');
          themePreview.hidden = true;
        }
      }
    } catch (error) {
      hasPhoto = false;
    }
    renderTheme();
  }

  async function saveTheme(nextTheme, palette) {
    const result = await api.setTheme({ theme: nextTheme, palette: palette || null });
    if (!result || !result.ok) {
      notify(result && result.error === 'invalid_palette' ? '生成的色板不可用，请换一张照片' : '主题保存失败');
      return false;
    }
    currentTheme = { theme: nextTheme, palette: nextTheme === 'photo' ? palette : null };
    themeBoot?.writeCache(currentTheme);
    renderTheme();
    return true;
  }

  async function choosePhoto() {
    if (!api.choosePhotoTheme || !theme) return;
    if (themeChoose) themeChoose.disabled = true;
    try {
      const picked = await api.choosePhotoTheme();
      if (!picked || picked.canceled) return;
      if (!picked.ok || !picked.dataUrl) {
        notify('无法读取这张照片');
        return;
      }
      const generated = await theme.generateFromImage(picked.dataUrl);
      if (!generated || !generated.ok) {
        notify('这张照片无法提取色板，请换一张');
        return;
      }
      hasPhoto = true;
      if (!(await saveTheme('photo', generated.palette))) return;
      renderReport(generated.report);
      await refreshPhotoPreview();
      notify('已按照片生成主题');
    } catch (error) {
      notify('生成主题失败，请重试');
    } finally {
      if (themeChoose) themeChoose.disabled = false;
    }
  }

  async function selectThemeMode(mode) {
    if (mode !== 'photo') {
      if (await saveTheme('classic', null)) renderReport(null);
      return;
    }
    // 已经有照片生成过的色板就直接切回照片主题，不必重新选图。
    if (currentTheme.palette) {
      if (await saveTheme('photo', currentTheme.palette)) return;
    }
    const cached = themeBoot?.readCache();
    if (cached && cached.theme === 'photo' && cached.palette) {
      if (await saveTheme('photo', cached.palette)) return;
    }
    await choosePhoto();
  }

  async function clearPhoto() {
    if (!api.clearPhotoTheme) return;
    const result = await api.clearPhotoTheme();
    if (!result || !result.ok) {
      notify('清除照片失败');
      return;
    }
    hasPhoto = false;
    renderReport(null);
    if (currentTheme.theme === 'photo') await saveTheme('classic', null);
    await refreshPhotoPreview();
    notify('已清除主题照片');
  }

  /* ==================== 桌宠设置卡片 ==================== */

  function renderPetSettings() {
    const pet = (currentSettings && currentSettings.pet) || { enabled: true, size: 'medium' };
    if (petEnabled) petEnabled.checked = pet.enabled !== false;
    for (const button of petSizeButtons) {
      const selected = button.dataset.petSize === pet.size;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
    }
  }

  async function savePetSettings(payload) {
    if (!api.setPetSettings) return;
    const result = await api.setPetSettings(payload);
    if (!result || !result.ok) {
      notify('桌宠设置保存失败');
      return;
    }
    currentSettings = result.settings || currentSettings;
    renderPetSettings();
  }

  /* ==================== 宠物页：对话 ==================== */

  function renderChat(conversations) {
    if (!chatLog) return;
    chatLog.replaceChildren();
    const rows = Array.isArray(conversations) ? conversations.slice(-60) : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'pet-chat-empty';
      empty.textContent = '还没有对话。可以直接在这里问，桌宠也会在桌面上等你。';
      chatLog.appendChild(empty);
      return;
    }
    for (const entry of rows) {
      const item = document.createElement('article');
      item.className = `pet-chat-message ${entry.role === 'assistant' ? 'is-assistant' : 'is-user'}`;
      const bubble = document.createElement('p');
      // 模型输出属于不可信内容，一律走 textContent，绝不拼 HTML。
      bubble.textContent = entry.content;
      item.appendChild(bubble);
      chatLog.appendChild(item);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderMemory(longTerm) {
    if (!memoryList) return;
    memoryList.replaceChildren();
    const rows = Array.isArray(longTerm) ? longTerm : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'pet-memory-empty';
      empty.textContent = '还没有长期记忆。写一句「我习惯晚上写代码」，桌宠以后都会记得。';
      memoryList.appendChild(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = 'pet-memory-row';
      const text = document.createElement('span');
      text.textContent = entry.content;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pet-memory-remove';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除记忆：${entry.content}`);
      remove.addEventListener('click', () => deleteMemory(entry.id));
      row.append(text, remove);
      memoryList.appendChild(row);
    }
  }

  function renderLlmStatus() {
    if (!llmStatus) return;
    llmStatus.textContent = llmConfigured ? '已连接' : '未配置';
    llmStatus.dataset.state = llmConfigured ? 'saved' : 'empty';
    if (chatHint) {
      chatHint.textContent = llmConfigured
        ? '回答使用与本机智能能力相同的 DeepSeek 配置，对话会写入桌宠记忆。'
        : '还没有配置 DeepSeek Key，先在「设置 · API 配置」里填写后桌宠才能回答。';
    }
    if (chatInput) chatInput.disabled = !llmConfigured;
    if (chatSend) chatSend.disabled = !llmConfigured || chatBusy;
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    if (chatSend) chatSend.disabled = busy || !llmConfigured;
    if (chatInput) chatInput.disabled = busy || !llmConfigured;
  }

  function chatErrorMessage(error) {
    if (error === 'not_configured') return '先在「设置 · API 配置」里填写 DeepSeek Key';
    if (error === 'timeout') return '桌宠没来得及回答，再试一次吧';
    if (error === 'empty_message') return '先写点什么再发送';
    if (typeof error === 'string' && error.startsWith('http_')) return '模型服务返回异常，请检查 Key 与模型名';
    return '桌宠暂时无法回答，请稍后再试';
  }

  async function refreshMemory() {
    if (!api.petMemoryGet) return;
    try {
      const memory = await api.petMemoryGet();
      renderChat(memory && memory.conversations);
      renderMemory(memory && memory.longTerm);
    } catch (error) {
      // 读取失败保留上一次渲染结果。
    }
  }

  async function refreshLlmState() {
    if (!api.petState) return;
    try {
      const state = await api.petState();
      llmConfigured = Boolean(state && state.llmConfigured);
    } catch (error) {
      llmConfigured = false;
    }
    renderLlmStatus();
  }

  async function sendChat(message) {
    const text = String(message == null ? '' : message).trim();
    if (!text || chatBusy || !api.petChat) return;
    setChatBusy(true);
    try {
      const result = await api.petChat({ message: text });
      if (!result || !result.ok) {
        notify(chatErrorMessage(result && result.error));
        return;
      }
      await refreshMemory();
    } catch (error) {
      notify(chatErrorMessage('request_failed'));
    } finally {
      setChatBusy(false);
    }
  }

  async function addMemory(content) {
    if (!api.petMemoryAdd) return;
    const result = await api.petMemoryAdd({ content });
    if (!result || !result.ok) {
      notify('这条记忆没能保存');
      return;
    }
    renderMemory(result.memory && result.memory.longTerm);
  }

  async function deleteMemory(id) {
    if (!api.petMemoryDelete) return;
    const result = await api.petMemoryDelete({ id, kind: 'longTerm' });
    if (!result || !result.ok) {
      notify('删除失败');
      return;
    }
    renderMemory(result.memory && result.memory.longTerm);
  }

  async function clearMemory(kind) {
    if (!api.petMemoryClear) return;
    const result = await api.petMemoryClear(kind ? { kind } : {});
    if (!result || !result.ok) {
      notify('清空失败');
      return;
    }
    if (!kind || kind === 'conversations') renderChat(result.memory && result.memory.conversations);
    if (!kind || kind === 'longTerm') renderMemory(result.memory && result.memory.longTerm);
  }

  /* ==================== 事件 ==================== */

  for (const button of themeModeButtons) {
    button.addEventListener('click', () => { void selectThemeMode(button.dataset.themeMode); });
  }
  themeReset?.addEventListener('click', () => { void selectThemeMode('classic'); });
  themeChoose?.addEventListener('click', () => { void choosePhoto(); });
  themeClear?.addEventListener('click', () => { void clearPhoto(); });

  petEnabled?.addEventListener('change', () => { void savePetSettings({ enabled: petEnabled.checked }); });
  for (const button of petSizeButtons) {
    button.addEventListener('click', () => { void savePetSettings({ size: button.dataset.petSize }); });
  }

  chatForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = chatInput ? chatInput.value : '';
    if (chatInput) chatInput.value = '';
    void sendChat(value);
  });
  chatInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // 输入法组合态不得提交，否则选词回车会直接发出去。
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const value = chatInput.value;
    chatInput.value = '';
    void sendChat(value);
  });

  memoryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = memoryInput ? memoryInput.value.trim() : '';
    if (!value) return;
    if (memoryInput) memoryInput.value = '';
    void addMemory(value);
  });

  conversationClear?.addEventListener('click', () => { void clearMemory('conversations'); });
  // 退出桌宠：关闭后桌宠窗口销毁、「宠物」页随之隐藏，可随时在设置里重新开启
  petDisable?.addEventListener('click', async () => {
    petDisable.disabled = true;
    try {
      const result = await api.setPetSettings({ enabled: false });
      if (!result || !result.ok) {
        notify('关闭桌宠失败，请重试');
        return;
      }
      currentSettings = result.settings || currentSettings;
      renderPetSettings();
      notify('桌宠已关闭，可在「设置 · 桌宠」重新开启');
    } finally {
      petDisable.disabled = false;
    }
  });
  memoryClear?.addEventListener('click', () => { void clearMemory('longTerm'); });

  api.onPetMemoryChanged?.((memory) => {
    renderChat(memory && memory.conversations);
    renderMemory(memory && memory.longTerm);
  });

  api.onAppSettingsChanged?.((settings) => {
    currentSettings = settings;
    const applied = themeBoot ? themeBoot.applyPayload(settings) : currentTheme;
    currentTheme = applied;
    themeBoot?.writeCache(applied);
    renderTheme();
    renderPetSettings();
    void refreshLlmState();
  });

  // 切到「宠物」页时拉一次最新记忆：桌宠窗口可能刚在桌面聊过。
  document.addEventListener('notch:tabchange', (event) => {
    if (event && event.detail && event.detail.tab === 'pet') void refreshMemory();
  });

  /* ==================== 启动 ==================== */

  async function boot() {
    const settings = await api.getAppSettings?.().catch(() => null);
    if (settings) {
      currentSettings = settings;
      const applied = themeBoot ? themeBoot.applyPayload(settings) : currentTheme;
      currentTheme = applied;
      themeBoot?.writeCache(applied);
    }
    renderTheme();
    renderPetSettings();
    renderReport(null);
    await Promise.all([refreshPhotoPreview(), refreshMemory(), refreshLlmState()]);
  }

  void boot();
})();
