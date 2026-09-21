const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// theme-boot.js 是渲染层脚本，但它只依赖 window / localStorage 两个全局，
// 因此可以在 vm 沙箱里真实执行，验证「启动先上色、再与主进程对账」这条路径。
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme-boot.js'), 'utf8');

const PHOTO_PALETTE = {
  bg: '#101418',
  surface1: '#161b20',
  surface2: '#1d242b',
  surface3: '#252d35',
  hairline: 'rgba(255,255,255,0.08)',
  hairlineSoft: 'rgba(255,255,255,0.06)',
  highlightTop: 'rgba(255,255,255,0.07)',
  squircleHighlight: 'rgba(255,255,255,0.16)',
  text1: '#F2F5F8',
  text2: '#B6C0CA',
  text3: '#828C96',
  text4: '#59626B',
  accent: '#6EA8FF',
  scrollThumb: 'rgba(255,255,255,0.08)',
  scrollThumbHover: 'rgba(255,255,255,0.20)',
  tooltipBg: 'rgba(0,0,0,0.92)',
  itemHover: 'rgba(255,255,255,0.04)',
  panelShadow: 'rgba(0,0,0,0.42)',
};

// vm 沙箱内创建的对象与宿主对象原型不同，deepStrictEqual 会判不等；
// 断言前统一做一次纯数据归一化。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function boot({ cache, rawCache, applyResult = true } = {}) {
  const calls = [];
  const store = new Map();
  if (cache !== undefined) store.set('notch-theme-cache-v1', JSON.stringify(cache));
  if (rawCache !== undefined) store.set('notch-theme-cache-v1', rawCache);

  const theme = {
    apply: (palette, surface) => {
      calls.push({ type: 'apply', palette, surface });
      return applyResult;
    },
    clear: () => calls.push({ type: 'clear' }),
  };

  const sandbox = {
    window: { NotchTheme: theme },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    console,
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { calls, api: sandbox.window.NotchThemeBoot, store, theme };
}

test('theme boot applies the cached palette before the panel paints', () => {
  const { calls, api } = boot({ cache: { theme: 'photo', palette: PHOTO_PALETTE } });
  assert.deepEqual(plain(calls), [{ type: 'apply', palette: PHOTO_PALETTE, surface: 'app' }]);
  assert.equal(api.readCache().theme, 'photo');
});

test('theme boot reconciles the main-process settings payload, which uses themePalette', () => {
  // 回归：主进程 settings:get 回传的键是 themePalette，曾经因为只读 palette
  // 导致启动对账把照片主题误清回经典黑。
  const { calls, api } = boot({ cache: { theme: 'photo', palette: PHOTO_PALETTE } });
  calls.length = 0;

  const applied = api.applyPayload({ theme: 'photo', themePalette: PHOTO_PALETTE });
  assert.deepEqual(plain(calls), [{ type: 'apply', palette: PHOTO_PALETTE, surface: 'app' }]);
  assert.equal(applied.theme, 'photo');
  assert.deepEqual(plain(applied.palette), PHOTO_PALETTE);
});

test('theme boot still accepts a palette-shaped payload', () => {
  const { calls, api } = boot({});
  calls.length = 0;
  const applied = api.applyPayload({ theme: 'photo', palette: PHOTO_PALETTE });
  assert.deepEqual(plain(calls), [{ type: 'apply', palette: PHOTO_PALETTE, surface: 'app' }]);
  assert.equal(applied.theme, 'photo');
});

test('classic theme clears the injected variables instead of applying a palette', () => {
  const { calls, api } = boot({ cache: { theme: 'photo', palette: PHOTO_PALETTE } });
  calls.length = 0;

  assert.deepEqual({ ...api.applyPayload({ theme: 'classic', themePalette: null }) }, { theme: 'classic', palette: null });
  assert.deepEqual(plain(calls), [{ type: 'clear' }]);
  assert.deepEqual({ ...api.applyPayload(null) }, { theme: 'classic', palette: null });
  assert.deepEqual(plain(calls), [{ type: 'clear' }, { type: 'clear' }]);
});

test('a photo payload without a palette or with a rejected palette falls back to classic', () => {
  const { calls, api } = boot({});
  calls.length = 0;
  assert.equal(api.applyPayload({ theme: 'photo' }).theme, 'classic');
  assert.deepEqual(plain(calls), [{ type: 'clear' }]);

  const rejected = boot({ applyResult: false });
  rejected.calls.length = 0;
  assert.equal(rejected.api.applyPayload({ theme: 'photo', themePalette: PHOTO_PALETTE }).theme, 'classic');
  assert.deepEqual(plain(rejected.calls), [
    { type: 'apply', palette: PHOTO_PALETTE, surface: 'app' },
    { type: 'clear' },
  ]);
});

test('theme cache survives a round trip and a corrupt cache degrades to classic', () => {
  const { api, store } = boot({});
  api.writeCache({ theme: 'photo', palette: PHOTO_PALETTE });
  assert.deepEqual(JSON.parse(store.get('notch-theme-cache-v1')), { theme: 'photo', palette: PHOTO_PALETTE });

  const corrupt = boot({ rawCache: '{not json' });
  assert.equal(corrupt.api.readCache(), null);
  assert.deepEqual(corrupt.calls, [{ type: 'clear' }]);
});
