const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace.js'), 'utf8');
const effectsJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'effects.js'), 'utf8');
const themeJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme.js'), 'utf8');
const themeBootJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme-boot.js'), 'utf8');
const petPanelJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet-panel.js'), 'utf8');
const petHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.html'), 'utf8');
const petJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('clipboard rows define both favorite icons before rendering entries', () => {
  assert.match(appJs, /const starOutlineSvg\s*=/);
  assert.match(appJs, /const starFilledSvg\s*=/);
});

test('notes have a dedicated top-level tab and management panel', () => {
  assert.match(html, /data-tab="notes"/);
  assert.match(html, /id="tab-notes"/);
  assert.match(html, /id="notes-search"/);
  assert.match(html, /id="notes-list"/);
  assert.match(html, /id="notes-detail"/);
});

test('home scratch note keeps only the save action', () => {
  const homeNote = html.match(/<section class="tile home-note"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(homeNote, /id="note-save-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library"/);
});

test('recordings expose in-page API settings and create a live draft while recording', () => {
  assert.match(html, /id="recording-configure"/);
  assert.match(workspaceJs, /function beginRecordingDraft\(\)/);
  assert.match(workspaceJs, /recordingLiveTranscript/);
  assert.match(workspaceJs, /configure-transcription/);
});

test('a live recording can be paused, resumed, and stopped from the recordings tab', () => {
  assert.match(workspaceJs, /recording-live-pause/);
  assert.match(workspaceJs, /recording-live-stop/);
  assert.match(workspaceJs, /togglePauseRecording/);
  assert.match(workspaceJs, /stopRecording/);
});

test('homepage visibility has one storage key, exact validation, and lifecycle events', () => {
  assert.match(appJs, /notch-home-hidden-modules-v1/);
  assert.match(appJs, /validateHomeWidgetLayout/);
  assert.match(appJs, /window\.NotchHome\s*=/);
  assert.match(appJs, /notch:home-modules-changed/);
  assert.match(appJs, /notch:home-layout-error/);
  assert.match(appJs, /stopMirror\(\)/);
  assert.match(appJs, /new Set\(homeTiles\.map\(\(tile\) => tile\.dataset\.homeModule\)\)/);
});

test('settings exposes exactly one switch for every homepage widget', () => {
  const switches = [...html.matchAll(/data-settings-home-module="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(switches, [
    'music', 'pomodoro', 'recorder', 'windows', 'mirror', 'note', 'commands',
  ]);
  assert.match(workspaceJs, /isRecordingActive/);
  assert.match(workspaceJs, /recording_active/);
  assert.match(workspaceJs, /at_least_one_required/);
});

test('settings exposes every panel tab as a possible default opening page', () => {
  const select = html.match(/<select id="settings-default-tab"[\s\S]*?<\/select>/)?.[0] || '';
  const options = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, [
    'home', 'todo', 'notes', 'links', 'recordings', 'credentials', 'clip', 'pet', 'settings',
  ]);
  assert.match(workspaceJs, /setDefaultTab/);
});

test('hidden visual widgets stop presentation-only background work', () => {
  assert.match(effectsJs, /setEnabled/);
  assert.match(effectsJs, /notch:home-modules-changed/);
  assert.match(workspaceJs, /NotchHome\?\.isVisible/);
});

/* ==================== 照片生成换肤与桌宠 ==================== */

test('photo theme module is loaded before the panel boots and is cached for a flash-free start', () => {
  // 主题必须早于 app.js 应用：否则第一帧会先闪经典黑。
  const themeIndex = html.indexOf('src="theme.js"');
  const bootIndex = html.indexOf('src="theme-boot.js"');
  const appIndex = html.indexOf('src="app.js"');
  assert.ok(themeIndex > -1 && bootIndex > themeIndex && appIndex > bootIndex);

  assert.match(themeJs, /global\.NotchTheme\s*=/);
  assert.match(themeJs, /generateFromImage/);
  assert.match(themeJs, /normalizePalette/);
  assert.match(themeJs, /CLASSIC_PALETTE/);
  assert.match(themeBootJs, /notch-theme-cache-v1/);
  assert.match(themeBootJs, /window\.NotchThemeBoot\s*=/);
  // 叠加层通道：浅色照片主题必须能把白色叠加整体翻成黑色。
  assert.match(themeJs, /--overlay-rgb/);
  assert.match(stylesCss, /--overlay-rgb:\s*255, 255, 255/);
});

test('settings exposes an appearance card that only swaps colour tokens', () => {
  assert.match(html, /id="settings-theme-modes"/);
  assert.match(html, /data-theme-mode="classic"/);
  assert.match(html, /data-theme-mode="photo"/);
  assert.match(html, /id="settings-theme-choose"/);
  assert.match(html, /id="settings-theme-clear"/);
  assert.match(html, /id="settings-theme-reset"/);
  assert.match(html, /id="settings-theme-photo-preview"/);

  assert.match(petPanelJs, /generateFromImage/);
  assert.match(petPanelJs, /setTheme/);
  // 实测对比度必须来自生成结果，不能写死。
  assert.match(petPanelJs, /text1\/bg/);
  assert.match(petPanelJs, /toFixed\(2\)/);
});

test('desktop pet is a separate transparent window page with its own renderer', () => {
  // 覆盖窗口用自己的 CSP 与脚本，不共用面板页面。
  assert.match(petHtml, /content="default-src 'self'/);
  assert.match(petHtml, /src="\.\/pet\.js"/);
  assert.match(petHtml, /href="\.\/pet\.css"/);
});

test('preload exposes one narrow bridge for theme and pet instead of raw IPC', () => {
  assert.match(preloadJs, /setTheme:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('settings:set-theme'/);
  assert.match(preloadJs, /choosePhotoTheme:/);
  assert.match(preloadJs, /petState:/);
  assert.match(preloadJs, /petChat:/);
  assert.match(preloadJs, /petMemoryClear:/);
  assert.match(preloadJs, /petSetInteractive:/);
  assert.match(preloadJs, /petOpenPanel:/);
  assert.match(preloadJs, /onPetEvent:/);
  assert.match(preloadJs, /onOpenPet:/);
  // 渲染进程不得直接拿 Electron。
  assert.doesNotMatch(petPanelJs, /require\(['"]electron['"]\)/);
  assert.doesNotMatch(themeJs, /require\(['"]electron['"]\)/);
});

test('pet tab only exists while the pet feature is enabled and opens the panel on demand', () => {
  assert.match(html, /data-tab="pet"/);
  assert.match(html, /id="tab-pet"/);
  assert.match(html, /id="pet-chat-log"/);
  assert.match(html, /id="pet-chat-input"/);
  assert.match(html, /id="pet-memory-list"/);
  assert.match(html, /id="pet-memory-input"/);
  assert.match(appJs, /'clip', 'pet', 'settings'/);
  assert.match(appJs, /onOpenPet/);
  assert.match(appJs, /settings\.pet\.enabled === false/);
  assert.match(petPanelJs, /notch:tabchange/);
});

test('pet memory is written by the main process only, never by the renderer', () => {
  const petJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
  assert.match(preloadJs, /petMemoryGet:/);
  assert.match(petPanelJs, /petMemoryGet/);
  assert.doesNotMatch(petPanelJs, /localStorage\.setItem\('notch-pet-memory/);
  assert.doesNotMatch(petJs, /require\(['"]electron['"]\)/);
});

test('screen recording permission is requested on demand instead of at startup', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // 启动自检不得再碰屏幕录制：macOS 只有在应用真正发起过一次捕获后才会登记，
  // 启动时把用户指向系统设置是死胡同（列表里没有条目）。
  const startupPrompt = mainJs.match(/async function promptForMissingPermissions\(\)[\s\S]*?\r?\n}\r?\n/)?.[0] || '';
  assert.ok(startupPrompt, 'promptForMissingPermissions 必须存在');
  // 只看代码本身：注释里会解释「为什么不在这里提示屏幕录制」，不应算作用户可见文案。
  const startupCode = startupPrompt.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(startupCode, /desktopCapturer/);
  assert.doesNotMatch(startupCode, /屏幕录制/);
  assert.match(startupCode, /辅助功能/);

  // 按需申请：真正用到「当前窗口」时触发一次真实捕获完成系统登记。
  assert.match(mainJs, /async function requestScreenRecordingAccess\(\)/);
  assert.match(mainJs, /screenRecordingPromptRequested/);
  assert.match(mainJs, /ipcMain\.handle\('privacy:request-screen-recording'/);

  assert.match(preloadJs, /requestScreenRecording:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('privacy:request-screen-recording'/);
  assert.match(workspaceJs, /requestScreenRecording/);
});

test('pet renders the Xiaobei sprite library with a priority-based animation player', () => {
  const petCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8');
  assert.match(petHtml, /id="pet-sprite-img"/);
  assert.doesNotMatch(petHtml, /pet-sprite-canvas/);
  assert.match(petJs, /const PET_ANIMS = \{/);

  // 动画映射表里声明的每一帧都必须真实存在于素材库
  const block = petJs.match(/const PET_ANIMS = \{[\s\S]*?\r?\n\};/)?.[0] || '';
  const entries = [...block.matchAll(/dir: '(\w+)',\s+prefix: '([\w-]+)',\s+frames: (\d+)/g)];
  assert.ok(entries.length >= 9, '至少映射 9 组动画');
  for (const [, dir, prefix, frames] of entries) {
    for (let i = 1; i <= Number(frames); i++) {
      const file = path.join(__dirname, '..', 'renderer', 'assets', 'pet', dir, `${prefix}-${String(i).padStart(2, '0')}.png`);
      assert.ok(fs.existsSync(file), `缺少帧素材: ${file}`);
    }
  }

  // 播放器分层优先级与关键挂钩
  assert.match(petJs, /pettingUntil/);
  assert.match(petJs, /guidingUntil/);
  assert.match(petJs, /mode === 'thinking'\) return 'thinking'/);
  assert.match(petJs, /state\.phase === 'rest'\) return 'sleepy'/);
  // 平滑插画：不再像素化，舞台回正方形，尺寸三档 64/96/128
  assert.doesNotMatch(petCss, /image-rendering: pixelated/);
  assert.doesNotMatch(petCss, /28 \/ 24/);
  assert.match(petCss, /--pet-size: 64px/);
  assert.match(petCss, /--pet-size: 96px/);
  assert.match(petCss, /--pet-size: 128px/);
});
