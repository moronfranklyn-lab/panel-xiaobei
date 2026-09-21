const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 音乐模块从「汽水音乐」改成「按安装情况自动选择客户端」时，出现过一次静默失败：
// 常量声明改名为 MUSIC_SHORTCUT_JXA，但调用点仍写 SODA_SHORTCUT_JXA，
// 结果发按键时抛 ReferenceError 被 catch 吞掉，表现为“能启动客户端但控制无效”。
// 这个文件专门守住这一类「改名漏改调用点」的问题，以及品牌名不得写死在渲染层。
const root = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const mainServicesJs = fs.readFileSync(path.join(root, 'main-services.js'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(root, 'renderer', 'workspace.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('every runJxa constant is declared before use', () => {
  const used = [...mainJs.matchAll(/runJxa\(\s*([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'main.js 应至少调用一次 runJxa');
  for (const name of new Set(used)) {
    assert.match(mainJs, new RegExp(`const ${name} = `), `${name} 被调用但未声明`);
  }
});

test('no legacy Soda Music identifiers survive the client switch', () => {
  const legacy = ['SODA_MUSIC_APP', 'SODA_SHORTCUT_JXA', 'sodaMusicPlaying', 'launchSodaMusic',
    'sendSodaShortcut', 'sodaMusicRunning', 'controlSodaMusic', 'sodaShortcutSpec', 'soda_control_failed'];
  for (const name of legacy) {
    for (const [file, source] of [['main.js', mainJs], ['main-services.js', mainServicesJs], ['preload.js', preloadJs]]) {
      assert.ok(!source.includes(name), `${file} 仍有旧标识符 ${name}`);
    }
  }
});

test('music client brand name comes from the main process, not the renderer', () => {
  // 渲染层必须使用 music:status 下发的 label，不得硬编码任何客户端品牌名。
  // 只检查代码：注释里说明「支持哪些客户端」是允许的。
  const code = workspaceJs.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /status\.label/);
  assert.ok(!code.includes('汽水音乐'), '渲染层代码不应硬编码客户端品牌名');
  assert.ok(!code.includes('网易云音乐'), '渲染层代码不应硬编码客户端品牌名');
});

test('music apps are resolved by installation with a per-client bundle id', () => {
  assert.match(mainJs, /const MUSIC_APPS = \[/);
  assert.match(mainJs, /function resolveMusicApp\(\)/);
  // 两台客户端各自的 bundle id 都要在表里，JXA 靠它定位进程
  assert.match(mainJs, /com\.netease\.163music/);
  assert.match(mainJs, /com\.soda\.music/);
  // bundle id 由参数传入 JXA，而不是写死在脚本里
  assert.match(mainJs, /const bundleId = String\(argv\[3\]/);
  assert.match(mainJs, /appInfo\.bundleId/);
});
