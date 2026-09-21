'use strict';

/**
 * TO-DO Panel 桌宠渲染层。
 *
 * 该页面运行在整屏透明覆盖窗口里：窗口边界永不变化，宠物的一切位移都是
 * 本页面内的 CSS transform。鼠标穿透由主进程负责，渲染层只按命中结果
 * 告诉主进程「现在要不要吃鼠标」（petSetInteractive）。
 *
 * 所有 notchAPI 方法都可能不存在（例如在浏览器里单独打开调试），因此
 * 一律先做存在性判断，缺失时用内置默认值继续运行，不抛错。
 */

const root = document.getElementById('pet-root');
const stage = document.getElementById('pet-stage');
const petBody = document.getElementById('pet-body');
const bubbleLayer = document.getElementById('pet-bubble-layer');
const toastLayer = document.getElementById('pet-toast-layer');
const bubbleTemplate = document.getElementById('pet-bubble-template');
const toastTemplate = document.getElementById('pet-toast-template');

const api = window.notchAPI || null;
const petMotion = window.PetMotion;

const DEFAULT_CONFIG = {
  enabled: true,
  size: 'medium',
  theme: 'classic',
  palette: null,
  llmConfigured: false,
  motion: { x: 0.5, y: 0.12, facing: 1 },
};

const SIZE_NAMES = ['small', 'medium', 'large'];
const EVENT_KINDS = ['task', 'pomodoro', 'todo'];
const CLICK_DEBOUNCE_MS = 250;
const SAVE_THROTTLE_MS = 4000;
const EVENT_TOAST_GAP = 20;
const HIT_PADDING = 6;
const MIN_SPEED = 20;
const MAX_SPEED = 60;
const WALK_ACCELERATION = 140;
const TURN_DURATION_MS = 260;
const MIN_REST_MS = 18000;
const MAX_REST_MS = 36000;
const MIN_IDLE_MS = 6000;
const MAX_IDLE_MS = 14000;
const DEFAULT_TYPING_CHARS = 2;
const DEFAULT_TYPING_MS = 26;
// 竖直漫游幅度：只取可移动高度的 4%（约 30px），宠物始终待在屏幕底部一条线上。
// 之前是 0.3，再叠加 pickTargetY 按整个范围取值，多走几次就会爬到屏幕上方。
const VERTICAL_BAND = 0.04;
// 由照片主题注入、需要整体清理的内联色板变量（经典黑时全部移除）
const PALETTE_VARS = [
  '--palette-bg',
  '--palette-surface',
  '--palette-surface-2',
  '--palette-surface-3',
  '--palette-text',
  '--palette-text-soft',
  '--palette-hairline',
  '--palette-accent',
];

const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let reducedMotion = reduceMotionQuery.matches;
let cssMetrics = readCssMetrics();

// 拖拽状态：声明在模块顶部，供精灵选择与命中检测在任意时机安全读取
const DRAG_THRESHOLD = 4;
let dragSession = null;
let suppressClickAfterDrag = false;

const state = {
  ready: false,
  enabled: DEFAULT_CONFIG.enabled,
  config: normalizeConfig(DEFAULT_CONFIG),
  x: 0,
  y: 0,
  facing: 1,
  targetX: 0,
  targetY: 0,
  speed: 40,
  maxSpeed: 40,
  walkDistance: 0,
  pendingWalk: null,
  turnFlipAt: 0,
  turnUntil: 0,
  turnFlipped: false,
  phase: 'idle',
  loopActive: false,
  lastFrame: 0,
  saveAttemptAt: 0,
  hitActive: false,
  tracking: false,
  lastPointerX: null,
  lastPointerY: null,
  bubble: null,
  toast: null,
  typing: null,
  actionTimer: null,
  clickTimer: null,
  toastTimer: null,
};

/* ==================== 基础工具 ==================== */

function hasApi(name) {
  return Boolean(api && typeof api[name] === 'function');
}

async function callApi(name, payload) {
  if (!hasApi(name)) return null;
  try {
    if (payload === undefined) return await api[name]();
    return await api[name](payload);
  } catch (error) {
    return null;
  }
}

function subscribe(name, handler) {
  if (!hasApi(name)) return;
  try {
    api[name](handler);
  } catch (error) {
    /* 订阅失败时保持静默，页面继续以默认值运行 */
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstText(values, fallback) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

/** 读取无单位数值型自定义属性（百分比、时间、纯数字） */
function readCssNumber(name, fallback) {
  let raw = '';
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  } catch (error) {
    raw = '';
  }
  const parsed = parseFloat(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 读取带单位的长度型自定义属性，统一换算为像素 */
function readCssPixels(name, fallback) {
  let raw = '';
  try {
    raw = String(getComputedStyle(document.documentElement).getPropertyValue(name)).trim();
  } catch (error) {
    return fallback;
  }
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (raw.endsWith('vh')) return (parsed / 100) * (window.innerHeight || 0);
  if (raw.endsWith('vw')) return (parsed / 100) * (window.innerWidth || 0);
  if (raw.endsWith('rem')) return parsed * 16;
  return parsed;
}

function readCssMetrics() {
  return {
    safeMargin: clamp(readCssNumber('--pet-safe-margin', 8), 0, 40),
    bottomMargin: Math.max(0, readCssPixels('--pet-margin-bottom', 24)),
    toastGap: Math.max(0, readCssPixels('--pet-toast-gap', EVENT_TOAST_GAP)),
    typingChars: Math.max(1, Math.round(readCssNumber('--pet-typing-chars', DEFAULT_TYPING_CHARS))),
    typingMs: Math.max(6, readCssNumber('--pet-typing-ms', DEFAULT_TYPING_MS)),
    autoHideMs: Math.max(800, readCssNumber('--pet-toast-duration', 4600)),
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function petSizePx() {
  return Math.max(16, petBody.getBoundingClientRect().width || stage.offsetWidth || 132);
}

// 宠物在窗口内锚定，所以「移动窗口」就是「移动宠物」：
// 活动范围由屏幕工作区减去窗口自身尺寸得出，再留一点贴边余量。
function motionBounds() {
  const area = state.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const size = state.windowSize || { width: 140, height: 120 };
  const marginX = Math.min(24, Math.max(0, area.width * 0.02));
  const minX = area.x + marginX;
  const maxX = Math.max(minX, area.x + area.width - size.width - marginX);
  const minY = area.y;
  const maxY = Math.max(minY, area.y + area.height - size.height);
  return { minX, maxX, minY, maxY, area, size };
}

// 自主走动只发生在屏幕底部一带：可移动高度的 30%
function walkBand() {
  const bounds = motionBounds();
  const span = Math.max(0, bounds.maxY - bounds.minY);
  const top = bounds.maxY - span * clamp(VERTICAL_BAND, 0, 1);
  return { minY: Math.max(bounds.minY, top), maxY: bounds.maxY };
}

// 拖拽时放宽到整个可移动范围，平时收在底部活动带里
function clampY(value) {
  const bounds = motionBounds();
  if (dragSession && dragSession.moved) return clamp(value, bounds.minY, bounds.maxY);
  const band = walkBand();
  return clamp(value, band.minY, band.maxY);
}

/* ==================== 配置与主题 ==================== */

function normalizeSize(value) {
  return SIZE_NAMES.indexOf(value) >= 0 ? value : 'medium';
}

function normalizeConfig(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const motion = data.motion && typeof data.motion === 'object' ? data.motion : {};
  const facing = toNumber(motion.facing, 1);
  return {
    enabled: data.enabled !== false,
    size: normalizeSize(data.size),
    theme: normalizeTheme(data.theme),
    palette: data.palette && typeof data.palette === 'object' ? data.palette : null,
    llmConfigured: data.llmConfigured === true,
    motion: {
      x: clamp(toNumber(motion.x, 0.5), 0, 1),
      y: clamp(toNumber(motion.y, 0.12), 0, 1),
      facing: facing < 0 ? -1 : 1,
    },
    workArea: normalizeRect(data.workArea, { x: 0, y: 0, width: 1440, height: 900 }),
    windowSize: normalizeRect(data.windowSize, { x: 0, y: 0, width: 140, height: 120 }),
    bounds: normalizeRect(data.bounds, null),
  };
}

function normalizeRect(value, fallback) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) return fallback;
  const width = Math.max(1, toNumber(source.width, 0));
  const height = Math.max(1, toNumber(source.height, 0));
  if (!width || !height) return fallback;
  return { x: toNumber(source.x, 0), y: toNumber(source.y, 0), width, height };
}

function tokensOf(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : payload;
  return tokens && typeof tokens === 'object' ? tokens : {};
}

function readToken(tokens, keys) {
  for (const key of keys) {
    const value = tokens[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function hexToRgba(hex, alpha) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return '';
  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((part) => part + part)
          .join('')
      : digits;
  const value = parseInt(full, 16);
  if (!Number.isFinite(value)) return '';
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizeTheme(value) {
  return value === 'photo' ? 'photo' : 'classic';
}

function clearPalette() {
  for (const name of PALETTE_VARS) root.style.removeProperty(name);
  root.style.removeProperty('--palette-accent-soft');
  root.style.removeProperty('--pet-glow');
}

function applyPalette(payload, theme) {
  const tokens = tokensOf(payload);
  root.setAttribute('data-theme', theme === 'photo' ? 'photo' : 'classic');
  // 经典黑 = 无内联色板，直接回落到 pet.css 里的兜底值，保证「恢复默认」彻底
  clearPalette();
  if (!tokens || Object.keys(tokens).length === 0) return;

  const bg = readToken(tokens, ['--bg-base', 'bgBase', 'bg', 'background']);
  const surface = readToken(tokens, ['--surface-1', 'surface1', 'surface']);
  const surface2 = readToken(tokens, ['--surface-2', 'surface2']);
  const surface3 = readToken(tokens, ['--surface-3', 'surface3']);
  const text = readToken(tokens, ['--text-1', 'text1', 'text']);
  const textSoft = readToken(tokens, ['--text-2', 'text2', 'textSoft']);
  const hairline = readToken(tokens, ['--hairline', 'hairline']);
  const accent = readToken(tokens, ['--focus-ring', 'focusRing', 'accent']);

  const vars = {
    '--palette-bg': bg,
    '--palette-surface': surface || surface2,
    '--palette-surface-2': surface2 || surface,
    '--palette-surface-3': surface3 || surface2,
    '--palette-text': text,
    '--palette-text-soft': textSoft,
    '--palette-hairline': hairline,
    '--palette-accent': accent,
  };
  for (const name of Object.keys(vars)) {
    if (vars[name]) root.style.setProperty(name, vars[name]);
  }

  // 半透明强调色：十六进制时按 alpha 派生，其余形态（rgba 等）直接用原值兜底
  const accentForSoft = vars['--palette-accent'];
  if (accentForSoft) {
    const soft = hexToRgba(accentForSoft, 0.24);
    root.style.setProperty('--palette-accent-soft', soft || accentForSoft);
    root.style.setProperty('--pet-glow', hexToRgba(accentForSoft, 0.3) || accentForSoft);
  }
}

/* ==================== 位置与走动状态机 ==================== */

function setFacing(nextFacing) {
  const value = nextFacing < 0 ? -1 : 1;
  if (state.facing === value) return;
  state.facing = value;
  petBody.dataset.facing = String(value);
  applyFacing();
  scheduleSave(false);
}

// state.x / state.y 是「窗口左上角的屏幕坐标」。窗口只有宠物那么大，
// 因此把窗口移到目标位置就等于把宠物移过去；位置变更经 IPC 交给主进程执行。
const PET_MOVE_THROTTLE_MS = 33;
let lastPositionPushAt = 0;

function pushPetPosition(force) {
  const now = performance.now();
  if (!force && now - lastPositionPushAt < PET_MOVE_THROTTLE_MS) return;
  lastPositionPushAt = now;
  void callApi('petMove', { x: Math.round(state.x), y: Math.round(state.y) }).then((result) => {
    // 主进程会把窗口裁进工作区：采纳裁剪后的位置，避免持续推送越界坐标
    if (result && result.ok && result.bounds) {
      state.x = result.bounds.x;
      state.y = result.bounds.y;
    }
  });
}

// 舞台靠 CSS 的 margin-left 居中（不用 transform），所以 transform 只负责朝向翻转
function applyFacing() {
  stage.style.transform = state.facing < 0 ? 'scaleX(-1)' : '';
}

// 把 CSS 实测尺寸报给主进程，窗口大小据此计算，避免两边硬编码同一组数值
function reportLayout() {
  void callApi('petReportLayout', {
    petSize: petSizePx(),
    bubbleWidth: readCssPixels('--pet-bubble-width', 258),
    toastWidth: readCssPixels('--pet-toast-width', 236),
  });
}

// 气泡/提示卡要在宠物上方展开：按需向主进程申请额外空间，宠物位置保持不变
// 主进程可能因为加高窗口/贴边裁剪而移动窗口，渲染层必须采纳它返回的实际位置，
// 否则下一次 pet:move 会把窗口拽回旧坐标（表现为宠物位置漂移、拖拽跳变）。
function adoptBounds(bounds) {
  if (!bounds) return;
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    state.x = bounds.x;
    state.y = bounds.y;
    state.targetX = state.x;
    state.targetY = state.y;
    lastPositionPushAt = performance.now();
  }
  if (Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
    state.windowSize = { width: bounds.width, height: bounds.height };
  }
}

function syncChrome() {
  const bubbleGap = Math.max(0, readCssPixels('--pet-bubble-gap', 12));
  const toastGap = Math.max(0, readCssPixels('--pet-toast-gap', 20));
  let width = 0;
  let height = 0;
  if (state.bubble && !state.bubble.container.hidden) {
    width = Math.max(width, state.bubble.container.offsetWidth || 0);
    height += (state.bubble.container.offsetHeight || 0) + bubbleGap;
  }
  if (state.toast && state.toast.container && !state.toast.container.hidden) {
    width = Math.max(width, state.toast.container.offsetWidth || 0);
    height += (state.toast.container.offsetHeight || 0) + toastGap;
  }
  void callApi('petSetChrome', { width, height }).then((result) => {
    if (result && result.ok) adoptBounds(result.bounds);
  });
}

function placePet(x, y) {
  const bounds = motionBounds();
  state.x = clamp(x, bounds.minX, bounds.maxX);
  state.y = clampY(y);
  state.targetX = state.x;
  state.targetY = state.y;
  applyFacing();
  pushPetPosition();
}

function scheduleSave(force) {
  const now = Date.now();
  if (!force) {
    if (now - state.saveAttemptAt < SAVE_THROTTLE_MS) return;
    state.saveAttemptAt = now;
  }
  saveMotion();
}

function saveMotion() {
  state.saveAttemptAt = Date.now();
  const bounds = motionBounds();
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const payload = {
    x: Number(clamp((state.x - bounds.minX) / spanX, 0, 1).toFixed(4)),
    y: Number(clamp((state.y - bounds.minY) / spanY, 0, 1).toFixed(4)),
    facing: state.facing,
  };
  void callApi('petSaveMotion', payload);
}

function pickTargetX() {
  const bounds = motionBounds();
  const facing = Math.random() < 0.5 ? -1 : 1;
  let value = 0;
  if (facing < 0) {
    value = state.x - randomBetween(0.12, 0.42) * Math.max(1, bounds.maxX - bounds.minX);
  } else {
    value = state.x + randomBetween(0.12, 0.42) * Math.max(1, bounds.maxX - bounds.minX);
  }
  if (value < bounds.minX || value > bounds.maxX) {
    value = state.x + -facing * randomBetween(0.1, 0.32) * Math.max(1, bounds.maxX - bounds.minX);
  }
  return clamp(value, bounds.minX, bounds.maxX);
}

// 走动目标严格落在底部活动带内。此前用 motionBounds()（整个可移动范围）取目标，
// 每次都可能选到更高的位置，走几次就离开桌面底部一路往上。
function pickTargetY() {
  const band = walkBand();
  const reach = Math.max(0, (band.maxY - band.minY) * 0.35);
  return clamp(state.y + randomBetween(-reach, reach), band.minY, band.maxY);
}

function setPhase(phase) {
  if (state.phase === phase) return;
  state.phase = phase;
  stage.dataset.state = phase;
  if (phase !== 'walk') scheduleSave(true);
}

function beginWalk(targetX, targetY, maxSpeed) {
  state.targetX = targetX;
  state.targetY = targetY;
  state.maxSpeed = maxSpeed;
  state.speed = 0;
  state.walkDistance = 0;
  state.pendingWalk = null;
  setPhase('walk');
}

function startWalk() {
  const bounds = motionBounds();
  let pitch = randomBetween(0.16, 0.42);
  let targetX = state.x + (Math.random() < 0.5 ? -1 : 1) * pitch * Math.max(1, bounds.maxX - bounds.minX);
  if (targetX < bounds.minX || targetX > bounds.maxX) {
    targetX = pickTargetX();
  }
  targetX = clamp(targetX, bounds.minX, bounds.maxX);
  const targetY = pickTargetY();
  const maxSpeed = randomBetween(MIN_SPEED, MAX_SPEED);
  const direction = targetX >= state.x ? 1 : -1;
  spritePlayer.fidget = null;

  if (direction !== state.facing) {
    const now = performance.now();
    state.pendingWalk = { targetX, targetY, maxSpeed, direction };
    state.turnFlipAt = now + TURN_DURATION_MS / 2;
    state.turnUntil = now + TURN_DURATION_MS;
    state.turnFlipped = false;
    state.speed = 0;
    setPhase('turn');
    return;
  }

  beginWalk(targetX, targetY, maxSpeed);
}

function startRest() {
  state.speed = 0;
  state.pendingWalk = null;
  state.restUntil = performance.now() + randomBetween(MIN_REST_MS, MAX_REST_MS);
  setPhase('rest');
}

function startIdle() {
  state.speed = 0;
  state.pendingWalk = null;
  state.idleUntil = performance.now() + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS);
  setPhase('idle');
}

function interruptWalk() {
  if (state.phase !== 'walk' && state.phase !== 'turn') return;
  state.targetX = state.x;
  state.targetY = state.y;
  startIdle();
}

function nextState() {
  if (state.phase === 'walk') {
    startIdle();
    return;
  }
  if (state.phase === 'rest') {
    startIdle();
    return;
  }
  if (Math.random() < 0.82) startWalk();
  else startRest();
}

function loop(now) {
  if (!state.loopActive) return;
  const delta = state.lastFrame ? Math.min(0.05, (now - state.lastFrame) / 1000) : 0;
  state.lastFrame = now;

  if (state.phase === 'walk') {
    const dx = state.targetX - state.x;
    const dy = state.targetY - state.y;
    const remaining = Math.hypot(dx, dy);
    const motion = petMotion.advanceWalk({
      speed: state.speed,
      maxSpeed: state.maxSpeed,
      remaining,
      acceleration: WALK_ACCELERATION,
      delta,
    });
    state.speed = motion.speed;
    if (remaining <= motion.distance + 0.01 || remaining < 0.35) {
      state.walkDistance += remaining;
      state.x = state.targetX;
      state.y = state.targetY;
      pushPetPosition();
      scheduleSave(true);
      startIdle();
    } else {
      const progress = motion.distance / remaining;
      state.x += dx * progress;
      state.y += dy * progress;
      state.walkDistance += motion.distance;
      pushPetPosition();
      scheduleSave(false);
    }
  } else if (state.phase === 'turn') {
    if (!state.turnFlipped && now >= state.turnFlipAt && state.pendingWalk) {
      setFacing(state.pendingWalk.direction);
      state.turnFlipped = true;
    }
    if (now >= state.turnUntil && state.pendingWalk) {
      const pending = state.pendingWalk;
      beginWalk(pending.targetX, pending.targetY, pending.maxSpeed);
    }
  } else if (state.phase === 'rest' && now >= state.restUntil) {
    nextState();
  } else if (state.phase === 'idle' && now >= state.idleUntil) {
    nextState();
  }

  refreshHitRegion();
  requestAnimationFrame(loop);
}

function startLoop() {
  if (state.loopActive) return;
  state.loopActive = true;
  state.lastFrame = 0;
  requestAnimationFrame(loop);
}

function stopLoop() {
  state.loopActive = false;
}

/* ==================== 小贝动画播放器 ==================== */
// 素材：renderer/assets/pet/<动画>/<帧>.png（256x256 像素插画）。
// 动画选择按优先级分层：摸头反馈 > 事件动作 > 气泡状态 > 行走相位；
// Walk 不按固定 FPS 播放，帧相位由实际移动距离驱动，避免脚掌落地时滑行。

const PET_ANIMS = {
  idle:      { dir: 'Idle',      prefix: 'xiaobei-ragdoll-idle',      frames: 12, fps: 6,  loop: true },
  walk:      { dir: 'Walk',      prefix: 'xiaobei-ragdoll-walk',      frames: 8,  fps: 8,  loop: true },
  sleepy:    { dir: 'Sleepy',    prefix: 'xiaobei-ragdoll-sleepy',    frames: 4,  fps: 3,  loop: true },
  petting:   { dir: 'Petting',   prefix: 'xiaobei-ragdoll-petting',   frames: 12, fps: 10, loop: false },
  success:   { dir: 'Success',   prefix: 'xiaobei-ragdoll-success',   frames: 6,  fps: 10, loop: false },
  satisfied: { dir: 'Satisfied', prefix: 'xiaobei-ragdoll-satisfied', frames: 6,  fps: 8,  loop: false },
  uncertain: { dir: 'Uncertain', prefix: 'xiaobei-ragdoll-uncertain', frames: 6,  fps: 8,  loop: false },
  thinking:  { dir: 'Thinking',  prefix: 'xiaobei-ragdoll-thinking',  frames: 6,  fps: 6,  loop: true },
  waiting:   { dir: 'Waiting',   prefix: 'xiaobei-ragdoll-waiting',   frames: 6,  fps: 6,  loop: true },
  guiding:   { dir: 'Guiding',   prefix: 'xiaobei-ragdoll-guiding',   frames: 6,  fps: 10, loop: false },
  // 小动作：静息太久时随机播放，让小贝活起来
  scan:      { dir: 'Scan',     prefix: 'xiaobei-ragdoll-scan',           frames: 6, fps: 6, loop: false },
  watching:  { dir: 'CabinetWatch', prefix: 'xiaobei-ragdoll-cabinet-watch', frames: 8, fps: 6, loop: false },
};

const spriteImg = document.getElementById('pet-sprite-img');
const spriteGhost = document.getElementById('pet-sprite-ghost');
const spriteCache = new Map();

function petFrameSrc(name, index) {
  const anim = PET_ANIMS[name];
  return `assets/pet/${anim.dir}/${anim.prefix}-${String(index + 1).padStart(2, '0')}.png`;
}

function preloadPetAnim(name) {
  if (spriteCache.has(name)) return spriteCache.get(name);
  const anim = PET_ANIMS[name];
  const images = [];
  for (let i = 0; i < anim.frames; i++) {
    const image = new Image();
    image.decoding = 'async';
    image.src = petFrameSrc(name, i);
    images.push(image);
  }
  spriteCache.set(name, images);
  return images;
}

function preloadAllPetAnims() {
  Object.keys(PET_ANIMS).forEach(preloadPetAnim);
}

const spritePlayer = {
  timer: null,
  current: '',
  startedAt: 0,
  pettingUntil: 0,
  guidingUntil: 0,
  satisfiedUntil: 0,
  uncertainUntil: 0,
  fidget: null, // { name, until }：静息太久时的随机小动作
  nextFidgetAt: 0,
  lastBubbleMode: '',
  lastSrc: '',
};

const FIDGET_ANIMS = ['scan', 'watching', 'waiting'];

function crossfadeSprite(previousSrc) {
  if (!spriteImg || !spriteGhost || !previousSrc || reducedMotion) return;
  spriteGhost.src = previousSrc;
  spriteGhost.style.opacity = '1';
  spriteImg.style.opacity = '0';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      spriteImg.style.opacity = '1';
      spriteGhost.style.opacity = '0';
    });
  });
}

function pickPetAnimation(now) {
  if (dragSession && dragSession.moved) return 'petting';
  if (now < spritePlayer.pettingUntil) return 'petting';
  if (now < spritePlayer.guidingUntil) return 'guiding';
  if (now < spritePlayer.satisfiedUntil) return 'satisfied';
  if (now < spritePlayer.uncertainUntil) return 'uncertain';
  const action = petBody.getAttribute('data-action');
  if (action === 'cheer') return 'success';
  if (action === 'celebrate') return 'satisfied';
  if (action === 'shake') return 'uncertain';
  if (spritePlayer.fidget) return spritePlayer.fidget.name;
  if (state.bubble && !state.bubble.container.hidden) {
    const mode = state.bubble.mode;
    if (mode === 'thinking') return 'thinking';
    if (mode === 'unconfigured') return 'uncertain';
    return 'waiting';
  }
  if (state.phase === 'rest') return 'sleepy';
  if (state.phase === 'walk') return 'walk';
  return 'idle';
}

function spriteTick() {
  if (!spriteImg || document.hidden || !state.enabled) return;
  const now = performance.now();

  // 气泡模式切换沿：回复/出错时给一个短促的情绪反馈动画
  if (state.bubble && !state.bubble.container.hidden) {
    const mode = state.bubble.mode;
    if (mode !== spritePlayer.lastBubbleMode) {
      spritePlayer.lastBubbleMode = mode;
      if (mode === 'reply') spritePlayer.satisfiedUntil = now + PET_ANIMS.satisfied.frames * (1000 / PET_ANIMS.satisfied.fps);
      if (mode === 'error') spritePlayer.uncertainUntil = now + PET_ANIMS.uncertain.frames * (1000 / PET_ANIMS.uncertain.fps);
    }
  } else {
    spritePlayer.lastBubbleMode = '';
  }

  // 小动作调度：只在静息相位、没有气泡时触发，播完自动回到 Idle
  if (spritePlayer.fidget && now >= spritePlayer.fidget.until) spritePlayer.fidget = null;
  if (!spritePlayer.fidget && state.phase === 'idle' && !state.bubble && now >= spritePlayer.nextFidgetAt) {
    const name = FIDGET_ANIMS[Math.floor(Math.random() * FIDGET_ANIMS.length)];
    const anim = PET_ANIMS[name];
    spritePlayer.fidget = { name, until: now + anim.frames * (1000 / anim.fps) };
    spritePlayer.nextFidgetAt = now + 18000 + Math.random() * 17000;
  }

  const name = pickPetAnimation(now);
  if (name !== spritePlayer.current) {
    crossfadeSprite(spritePlayer.lastSrc);
    spritePlayer.current = name;
    spritePlayer.startedAt = now;
    preloadPetAnim(name);
  }
  const anim = PET_ANIMS[name];
  const images = spriteCache.get(name) || [];
  if (!images.length) return;
  const elapsed = Math.floor((now - spritePlayer.startedAt) / (1000 / anim.fps));
  const stride = Math.max(24, readCssPixels('--pet-size', 96) * 0.62);
  // 拖拽期间把「被摸头」当循环播放，长时间抱着也不会卡在末帧
  const loopThis = anim.loop || (name === 'petting' && dragSession && dragSession.moved);
  const index = name === 'walk'
    ? petMotion.walkFrameIndex(state.walkDistance, stride, images.length)
    : loopThis ? elapsed % images.length : Math.min(elapsed, images.length - 1);
  const src = images[index] && images[index].src;
  if (src && src !== spritePlayer.lastSrc) {
    spritePlayer.lastSrc = src;
    spriteImg.src = src;
  }
}

function startSpriteTicker() {
  if (spritePlayer.timer) return;
  preloadAllPetAnims();
  if (!spriteImg) return;
  spritePlayer.timer = setInterval(spriteTick, 60);
  spriteTick();
}

function stopSpriteTicker() {
  if (spritePlayer.timer) clearInterval(spritePlayer.timer);
  spritePlayer.timer = null;
  spritePlayer.lastSrc = '';
  if (spriteGhost) {
    spriteGhost.removeAttribute('src');
    spriteGhost.style.opacity = '0';
  }
  if (spriteImg) spriteImg.style.opacity = '1';
}

function syncSpriteTicker() {
  if (state.enabled && !reducedMotion) {
    startSpriteTicker();
    return;
  }
  stopSpriteTicker();
  // 降级或停用时定格在静息首帧，不留空白
  if (spriteImg) spriteImg.src = petFrameSrc('idle', 0);
}

/* ==================== 命中穿透去重 ==================== */

function hitPadding() {
  return Math.max(petSizePx() * 0.04, HIT_PADDING);
}

function inRect(x, y, rect, padding) {
  const pad = padding || 0;
  return (
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  );
}

function hitTest(x, y) {
  if (!root.classList.contains('is-ready')) return false;
  if (inRect(x, y, petBody.getBoundingClientRect(), hitPadding())) return true;
  if (state.bubble && !state.bubble.container.hidden) {
    if (inRect(x, y, state.bubble.container.getBoundingClientRect(), 4)) return true;
  }
  return false;
}

function updatePointerTarget(target) {
  state.hitActive = target;
  if (hasApi('petSetInteractive')) {
    void callApi('petSetInteractive', { interactive: target });
  }
}

function refreshHitRegion() {
  if (dragSession) return;
  if (!state.tracking) return;
  if (state.lastPointerX === null || state.lastPointerY === null) return;
  const target = hitTest(state.lastPointerX, state.lastPointerY);
  if (target === state.hitActive) return;
  updatePointerTarget(target);
}

/* ==================== 气泡 ==================== */

function createBubbleView() {
  const view = {};
  view.container = bubbleTemplate.content.firstElementChild.cloneNode(true);
  view.text = view.container.querySelector('[data-role="text"]');
  view.hint = view.container.querySelector('[data-role="hint"]');
  view.form = view.container.querySelector('[data-role="form"]');
  view.input = view.container.querySelector('[data-role="input"]');
  view.send = view.container.querySelector('[data-role="send"]');
  view.actions = view.container.querySelector('[data-role="actions"]');
  view.settings = view.container.querySelector('[data-role="settings"]');
  view.panel = view.container.querySelector('[data-role="panel"]');
  view.mode = 'ask';

  view.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitMessage();
  });
  view.panel.addEventListener('click', () => {
    closeBubble();
    void callApi('petOpenPanel');
  });
  view.settings.addEventListener('click', () => {
    closeBubble();
    void callApi('petOpenPanel');
  });
  view.input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBubble();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitMessage();
    }
  });
  return view;
}

function setBubbleMode(view, mode) {
  view.mode = mode;
  view.container.setAttribute('data-mode', mode);
  const showText = mode !== 'ask';
  view.text.hidden = !showText;
  view.form.hidden = mode !== 'ask' && mode !== 'reply';
  view.actions.hidden = mode !== 'unconfigured' && mode !== 'error';
  view.settings.hidden = mode !== 'unconfigured';
  view.panel.hidden = mode === 'ask';
}

function stopTyping() {
  if (!state.typing) return;
  clearInterval(state.typing.timer);
  state.typing = null;
}

function typeText(view, text) {
  stopTyping();
  const value = String(text == null ? '' : text);
  const chars = cssMetrics.typingChars;
  view.text.hidden = false;
  if (reducedMotion) {
    view.text.textContent = value;
    return;
  }
  let index = 0;
  view.text.textContent = '';
  state.typing = {
    timer: setInterval(() => {
      index += chars;
      if (index >= value.length) {
        view.text.textContent = value;
        stopTyping();
        return;
      }
      view.text.textContent = value.slice(0, index);
    }, cssMetrics.typingMs),
  };
}

/* 气泡/提示卡定位：以宠物当前实际像素位置为锚点，靠近屏幕边缘时自动翻转箭头方向 */
function placeAnchored(element, options) {
  const rect = petBody.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  element.style.left = `${Math.round(center)}px`;
  element.style.bottom = `${Math.round(options.bottom)}px`;
  const width = element.offsetWidth || 240;
  const half = width / 2;
  const rawLeft = clamp(center - half, 12, Math.max(12, window.innerWidth - width - 12));
  element.style.left = `${Math.round(rawLeft)}px`;
  const arrowX = clamp(center - rawLeft, 16, Math.max(16, width - 16));
  element.style.setProperty('--pet-arrow-left', `${Math.round(arrowX)}px`);
  element.style.setProperty('--pet-arrow-right', `${Math.round(width - arrowX)}px`);
  element.setAttribute('data-side', arrowX < width * 0.32 ? 'right' : arrowX > width * 0.68 ? 'left' : 'center');
}

function bubbleBottom() {
  const rect = petBody.getBoundingClientRect();
  const gap = Math.max(0, readCssPixels('--pet-bubble-gap', 12));
  const minBottom = window.innerHeight - rect.bottom + Math.max(24, rect.height * 0.4);
  return Math.max(window.innerHeight - rect.top + gap / 1.5, minBottom);
}

function layoutBubble() {
  if (!state.bubble) return;
  placeAnchored(state.bubble.container, { bottom: bubbleBottom() });
  syncChrome();
}

function layoutToast() {
  if (!state.toast) return;
  const rect = petBody.getBoundingClientRect();
  const bubbleActive = Boolean(state.bubble && !state.bubble.container.hidden);
  const bottom = bubbleActive
    ? bubbleBottom() + (state.bubble.container.offsetHeight || 0) + cssMetrics.toastGap
    : bubbleBottom();
  placeAnchored(state.toast.container, { bottom });
  void rect;
}

function openBubble(options) {
  interruptWalk();
  const settings = options || {};
  if (!state.enabled) return;
  if (!state.bubble) {
    state.bubble = createBubbleView();
    bubbleLayer.appendChild(state.bubble.container);
  }
  const view = state.bubble;
  view.token = (view.token || 0) + 1;

  if (settings.focus !== false) {
    setBubbleMode(view, 'ask');
    view.hint.textContent = '快问快答';
    view.text.textContent = '';
    view.input.value = '';
    view.container.classList.remove('is-busy');
    // 大脑没配置时直接给引导（文案 + 去设置按钮），而不是让用户打完一句
    // 才在发送后被拒绝。
    if (!state.config.llmConfigured) showUnconfigured(view);
  }
  bubbleLayer.hidden = false;
  view.container.hidden = false;
  view.container.classList.remove('is-leaving');
  layoutBubble();
  updatePointerTarget(true);
  refreshHitRegion();

  if (settings.focus === false) return;
  void focusPetWindow(true);
  requestAnimationFrame(() => {
    layoutBubble();
    try {
      view.input.focus({ preventScroll: true });
    } catch (error) {
      /* 焦点失败不影响气泡展示 */
    }
  });
}

function closeBubble() {
  if (!state.bubble) return;
  const view = state.bubble;
  view.token = (view.token || 0) + 1;
  view.container.hidden = true;
  bubbleLayer.hidden = true;
  view.container.classList.remove('is-busy');
  stopTyping();
  state.bubble = null;
  void focusPetWindow(false);
  syncChrome();
  refreshHitRegion();
}

function showReply(view, text, mode) {
  setBubbleMode(view, mode || 'reply');
  typeText(view, text);
  layoutBubble();
}

function errorMessage(code) {
  if (code === 'not_configured' || code === 'llm_not_configured' || code === 'no_key') {
    return '还没有配置 DeepSeek API Key，配置好我就能回答问题了。';
  }
  if (code === 'timeout') return '请求超时了，稍后再试一次吧。';
  if (code === 'request_failed') return '请求失败了，检查一下网络或 Key 再试。';
  if (typeof code === 'string' && code.trim()) return `出错了：${code.trim()}`;
  return '出错了，稍后再试一次吧。';
}

async function submitMessage() {
  const view = state.bubble;
  if (!view || view.mode === 'thinking') return;
  const message = String(view.input.value || '').trim();
  if (!message) {
    view.input.focus({ preventScroll: true });
    return;
  }

  if (!state.config.llmConfigured) {
    showUnconfigured(view);
    return;
  }

  view.input.value = '';
  view.container.classList.add('is-busy');
  view.hint.textContent = '思考中';
  setBubbleMode(view, 'thinking');
  layoutBubble();
  playAction('cheer');

  const token = view.token;
  const result = await callApi('petChat', { message });
  if (!state.bubble || state.bubble !== view || view.token !== token) return;

  view.container.classList.remove('is-busy');
  view.hint.textContent = '';

  if (!result || typeof result !== 'object') {
    showReply(view, errorMessage('request_failed'), 'error');
    return;
  }
  if (result.ok === true) {
    const reply = firstText([result.reply, result.message, result.content], '');
    showReply(view, reply || '我没有想好怎么回答。', 'reply');
    view.input.focus({ preventScroll: true });
    return;
  }
  if (result.error === 'not_configured') {
    // 只记下「大脑未配置」，不走完整的 config 归一化，避免顺手把尺寸/主题/位置重置成默认值
    state.config.llmConfigured = false;
    showUnconfigured(view);
    return;
  }
  showReply(view, errorMessage(result.error), 'error');
}

function showUnconfigured(view) {
  setBubbleMode(view, 'unconfigured');
  view.hint.textContent = '未配置';
  view.text.hidden = false;
  view.text.textContent = '还没有配置 DeepSeek API Key，配置好我就能回答问题了。';
  view.input.value = '';
  view.container.classList.remove('is-busy');
  layoutBubble();
}

async function focusPetWindow(focusable) {
  if (hasApi('petSetFocusable')) {
    await callApi('petSetFocusable', { focusable: focusable === true });
  }
  if (focusable === true && hasApi('petFocusWindow')) {
    await callApi('petFocusWindow');
  }
}

/* ==================== 事件提示卡 ==================== */

function sourceLabel(source) {
  const key = String(source || '').toLowerCase();
  if (key === 'codex') return 'Codex';
  if (key === 'claude') return 'Claude Code';
  if (key === 'gpt' || key === 'chatgpt') return 'GPT';
  return '任务';
}

function buildEventCopy(event) {
  const title = firstText([event.title], '');
  const body = firstText([event.body], '');
  if (event.kind === 'pomodoro') {
    return {
      title: title || '番茄钟结束',
      body: body || '这一段专注完成了，站起来动一动。',
    };
  }
  if (event.kind === 'todo') {
    return {
      title: title || '待办快到期了',
      body: body || '还有不到一小时就截止，先处理它吧。',
    };
  }
  return {
    title: title || '任务已完成',
    body: body || `${sourceLabel(event.source)} 那边结束了，可以查看了。`,
  };
}

function dismissToast() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  const toast = state.toast;
  if (!toast) return;
  state.toast = null;
  toast.container.classList.add('is-leaving');
  const timer = setTimeout(() => {
    if (toast.container.parentNode) toast.container.parentNode.removeChild(toast.container);
  }, Math.max(60, readCssNumber('--pet-bubble-duration', 180)));
  toast.leaveTimer = timer;
  syncChrome();
  refreshHitRegion();
}

function showToast(event) {
  dismissToast();
  const kind = EVENT_KINDS.indexOf(event.kind) >= 0 ? event.kind : 'task';
  const copy = buildEventCopy(event);
  const container = toastTemplate.content.firstElementChild.cloneNode(true);
  container.setAttribute('data-kind', kind);
  container.querySelector('[data-role="title"]').textContent = copy.title;
  container.querySelector('[data-role="body"]').textContent = copy.body;
  container.hidden = false;
  toastLayer.hidden = false;
  toastLayer.appendChild(container);
  state.toast = { container };
  layoutToast();
  syncChrome();
  refreshHitRegion();
  state.toastTimer = setTimeout(dismissToast, cssMetrics.autoHideMs);
}

function actionDurationMs(action) {
  if (action === 'cheer') return readCssNumber('--pet-event-task-duration', 1400);
  if (action === 'celebrate') return readCssNumber('--pet-event-pomodoro-duration', 1700);
  return readCssNumber('--pet-event-todo-duration', 800);
}

function playAction(action) {
  interruptWalk();
  if (state.actionTimer) {
    clearTimeout(state.actionTimer);
    state.actionTimer = null;
  }
  petBody.removeAttribute('data-action');
  if (reducedMotion) return;
  void petBody.offsetWidth;
  petBody.setAttribute('data-action', action);
  state.actionTimer = setTimeout(() => {
    state.actionTimer = null;
    petBody.removeAttribute('data-action');
  }, actionDurationMs(action));
}

function handlePetEvent(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const kind = EVENT_KINDS.indexOf(data.kind) >= 0 ? data.kind : 'task';
  const event = {
    kind,
    title: firstText([data.title], ''),
    body: firstText([data.body], ''),
    source: data.source,
  };
  const action = kind === 'pomodoro' ? 'celebrate' : kind === 'todo' ? 'shake' : 'cheer';
  const chatting = Boolean(state.bubble);
  playAction(action);
  // 输入中的对话不被打断：只播动作，不覆盖气泡
  if (chatting) return;
  showToast(event);
}

/* ==================== 拖拽 ==================== */
// 指针按下后移动超过阈值即进入拖拽：暂停自主走动，宠物跟随指针，松手保存位置。
// 坐标系与 placePet 一致——x 是左偏移，y 是距屏幕底部的高度，
// 所以指针向下移动对应 y 减小。

function beginDrag(event) {
  if (event.button !== 0 || !state.enabled) return;
  dragSession = {
    pointerId: event.pointerId,
    // 拖拽时窗口跟着指针走，必须换算成屏幕坐标再算位移。
    // 窗口是无边框的，所以 screenX = 窗口 x + clientX；窗口一旦移动，
    // clientX 会同步反向变化，因此这个换算在拖拽全程都稳定。
    startScreenX: state.x + event.clientX,
    startScreenY: state.y + event.clientY,
    originX: state.x,
    originY: state.y,
    moved: false,
  };
  interruptWalk();
  state.tracking = true;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  // 拖拽期间必须持续接收鼠标事件，否则指针一快就把宠物甩掉
  updatePointerTarget(true);
  try { petBody.setPointerCapture(event.pointerId); } catch (error) {}
  event.preventDefault();
}

function moveDrag(event) {
  if (!dragSession || event.pointerId !== dragSession.pointerId) return;
  const dx = (state.x + event.clientX) - dragSession.startScreenX;
  const dy = (state.y + event.clientY) - dragSession.startScreenY;
  if (!dragSession.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragSession.moved = true;
    stage.dataset.dragging = 'true';
  }
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  placePet(dragSession.originX + dx, dragSession.originY + dy);
  pushPetPosition(true);
  updatePointerTarget(true);
  event.preventDefault();
}

function endDrag(event) {
  if (!dragSession) return;
  if (event && event.pointerId !== undefined && event.pointerId !== dragSession.pointerId) return;
  const moved = dragSession.moved;
  dragSession = null;
  delete stage.dataset.dragging;
  try { if (event && event.pointerId !== undefined) petBody.releasePointerCapture(event.pointerId); } catch (error) {}
  if (moved) {
    saveMotion();
    // click 紧跟在 pointerup 之后触发：吞掉这一次，避免拖完顺手弹出气泡
    suppressClickAfterDrag = true;
    setTimeout(() => { suppressClickAfterDrag = false; }, 0);
  }
  refreshHitRegion();
}

/* ==================== 单击 / 双击 ==================== */

function handlePetClick() {
  if (suppressClickAfterDrag) return;
  interruptWalk();
  if (state.clickTimer) {
    clearTimeout(state.clickTimer);
    state.clickTimer = null;
    closeBubble();
    spritePlayer.guidingUntil = performance.now() + PET_ANIMS.guiding.frames * (1000 / PET_ANIMS.guiding.fps);
    void callApi('petOpenPanel');
    return;
  }
  spritePlayer.pettingUntil = performance.now() + PET_ANIMS.petting.frames * (1000 / PET_ANIMS.petting.fps);
  state.clickTimer = setTimeout(() => {
    state.clickTimer = null;
    if (state.bubble) {
      state.bubble.input.focus({ preventScroll: true });
      return;
    }
    openBubble();
  }, CLICK_DEBOUNCE_MS);
}

/* ==================== 生命周期 ==================== */

function updateConfig(payload) {
  const next = normalizeConfig(payload);
  state.config = next;
  state.enabled = next.enabled;
  root.setAttribute('data-size', next.size);
  applyPalette(next.palette, next.theme);
  // 窗口尺寸/工作区由主进程下发；窗口本身很小，绝不能用 innerWidth 当屏幕范围
  if (next.workArea) state.workArea = next.workArea;
  if (next.windowSize) state.windowSize = next.windowSize;
  if (next.bounds) {
    state.x = next.bounds.x;
    state.y = next.bounds.y;
    state.targetX = state.x;
    state.targetY = state.y;
  }
  cssMetrics = readCssMetrics();
  reportLayout();
  applyFacing();

  root.hidden = false;
  if (!next.enabled) {
    stopLoop();
    stopSpriteTicker();
    dismissToast();
    if (state.bubble) closeBubble();
    root.classList.remove('is-ready');
    return;
  }

  if (!state.ready) {
    const bounds = motionBounds();
    const span = Math.max(1, bounds.maxX - bounds.minX);
    const x = bounds.minX + next.motion.x * span;
    const y = bounds.minY + next.motion.y * Math.max(0, bounds.maxY - bounds.minY);
    placePet(x, y);
    setFacing(next.motion.facing);
    petBody.dataset.facing = String(state.facing);
    state.ready = true;
    pushPetPosition(true);
  }

  requestAnimationFrame(() => root.classList.add('is-ready'));

  if (reducedMotion) {
    stopLoop();
    stage.dataset.frozen = 'true';
    syncSpriteTicker();
    return;
  }
  stage.dataset.frozen = 'false';
  startIdle();
  startLoop();
  syncSpriteTicker();
}

function applyDocumentVisibility() {
  const hidden = document.hidden || !state.enabled;
  if (hidden) {
    stopLoop();
    return;
  }
  if (!reducedMotion && state.ready) startLoop();
}

function handleResize() {
  const bounds = motionBounds();
  cssMetrics = readCssMetrics();
  state.x = clamp(state.x, bounds.minX, bounds.maxX);
  state.y = clampY(state.y);
  state.targetX = clamp(state.targetX, bounds.minX, bounds.maxX);
  state.targetY = clampY(state.targetY);
  applyFacing();
  pushPetPosition(true);
  layoutBubble();
  layoutToast();
  refreshHitRegion();
}

function handlePointerMove(event) {
  state.tracking = true;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  // 拖拽期间交互状态由 moveDrag 强制保持，避免命中检测把窗口切回穿透
  if (dragSession) return;
  const target = hitTest(event.clientX, event.clientY);
  if (target === state.hitActive) return;
  updatePointerTarget(target);
}

function handlePointerLeave() {
  state.tracking = false;
  if (state.hitActive) updatePointerTarget(false);
}

function handleWindowBlur() {
  // 焦点离开（点桌面 / 面板展开）时气泡礼貌收起，交互状态一并归还
  if (state.bubble) closeBubble();
  handlePointerLeave();
}

function handleGlobalKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key !== 'Escape') return;
  if (!state.bubble) return;
  event.preventDefault();
  closeBubble();
}

/* ==================== 启动 ==================== */

petBody.dataset.facing = '1';
petBody.addEventListener('click', handlePetClick);
petBody.addEventListener('pointerdown', beginDrag);
document.addEventListener('pointermove', moveDrag, { passive: false });
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

document.addEventListener('pointermove', handlePointerMove, { passive: true });
document.addEventListener('pointerleave', handlePointerLeave, { passive: true });
document.addEventListener('keydown', handleGlobalKeydown);
window.addEventListener('resize', handleResize);
window.addEventListener('blur', handleWindowBlur);
window.addEventListener('beforeunload', () => saveMotion());
document.addEventListener('visibilitychange', applyDocumentVisibility);

if (reduceMotionQuery.addEventListener) {
  reduceMotionQuery.addEventListener('change', () => {
    reducedMotion = reduceMotionQuery.matches;
    if (reducedMotion) {
      stopLoop();
      stage.dataset.frozen = 'true';
    } else {
      stage.dataset.frozen = 'false';
      if (state.enabled) startLoop();
    }
    syncSpriteTicker();
  });
}

subscribe('onPetConfig', (payload) => {
  updateConfig(payload || DEFAULT_CONFIG);
});

subscribe('onPetTheme', (payload) => {
  const data = payload && typeof payload === 'object' ? payload : {};
  // 主题事件是权威来源：即使赶在 petState() 之前到达，也按事件里的 theme 走，
  // 不回落旧的 config，否则「照片主题恢复经典黑」会被上一次状态覆盖。
  const theme = normalizeTheme(data.theme);
  state.config.theme = theme;
  state.config.palette = data.palette && typeof data.palette === 'object' ? data.palette : null;
  applyPalette(state.config.palette, theme);
  layoutBubble();
  layoutToast();
});

subscribe('onPetEvent', (payload) => {
  handlePetEvent(payload);
});

// 主进程要求展开气泡输入：契约里的 onPetOpenBubble 与 preload 实际暴露的 onOpenPet 都接，
// 重复调用 openBubble 是幂等的（只重置输入态），不会叠加气泡。
function handleOpenBubbleRequest() {
  openBubble({ focus: true });
}

subscribe('onPetOpenBubble', handleOpenBubbleRequest);
subscribe('onOpenPet', handleOpenBubbleRequest);

(async () => {
  const initial = await callApi('petState');
  updateConfig(initial || DEFAULT_CONFIG);
})();
