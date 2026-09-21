# 照片生成换肤 + AI 桌宠设计

> 本文档是完整的实施交接文档：包含已与产品负责人确认的全部决策、架构落点与验收标准。实施者无需回溯任何会话，以本文档为准。

## 背景与目标

TO-DO Panel 当前为单一「经典黑」纯黑玻璃视觉，且没有桌宠能力。本次改造新增两个功能，**保留原样式为默认**：

1. **照片生成换肤**：用户上传一张照片，系统提取色板自动生成主题；经典黑保留为默认，随时一键恢复。
2. **AI 桌宠**：在桌面上自由活动的矢量宠物，拥有持久记忆，接入现有 DeepSeek 通道回答问题，并对任务完成 / 番茄钟 / 待办提醒做事件联动反应。

### 已确认的产品决策

| 决策点 | 结论 |
| --- | --- |
| 主题来源 | 不做预置主题套装；用户上传照片，主题从照片生成 |
| 桌宠形象 | CSS/SVG 矢量宠物，配色跟随主题联动（换肤即换宠） |
| 桌宠交互档位 | L2 事件联动（欢呼 / 庆祝 / 提醒 / 点击展开面板） |
| 桌宠默认状态 | 默认开启，可在设置页关闭 |
| 对话方式 | 混合：单击宠物 = 头顶气泡快问快答；双击宠物 = 展开面板进「宠物」页长聊与记忆管理 |
| 焦点互斥 | 不设互斥规则。面板失焦自动收起是既有行为，点宠物与之自然共存；聊天中途展开面板时气泡礼貌收起（上下文已保存） |

---

## 功能一：照片生成换肤

### 产品范围

设置页新增「外观」卡片：

- 主题模式两选一：「经典黑」（默认，现有视觉一个值都不改）与「照片主题」。
- 照片主题：上传 / 更换照片（系统文件选择器），实时预览生成的色板，应用后全应用生效。
- 「恢复默认」一键回到经典黑。
- 可选开关：「照片作为面板衬底」—— 展开面板时照片经高斯模糊作为背景，玻璃卡片浮于其上。第一版可不做，但架构预留。

### 色板提取与映射规则

提取在**渲染层**用原生 canvas 完成（降采样 + 色彩量化，如 median-cut 或简易 k-means），零依赖、无构建步骤。映射到 `renderer/styles.css` `:root` 现有语义 token，**只覆盖颜色类 token**，圆角 / 间距 / 字体 / 动效 token 一律不动（换肤不换版式）：

| Token 组 | 映射规则 |
| --- | --- |
| `--bg-base` / `--surface-1/2/3` | 照片主色调的**暗化梯度**，维持黑玻璃质感；照片整体偏亮（平均亮度高于阈值）时生成浅色变体（浅底深墨） |
| `--text-1..4` | 按 WCAG 对比度公式在代码内**实算**反推亮度，正文文本对底色不低于 4.5:1；禁止人工宣称达标，必须由代码验证 |
| `--hairline` / `--hairline-soft` / `--highlight-*` / `--scrollbar-*` / `--item-hover` / `--panel-shadow` / `--tooltip-bg` | 跟随底色同源推导 |
| `--p0..--p3`（红橙绿蓝） | **保留语义不替换**（它们是任务状态色），仅允许饱和度 / 轻微色调微调以贴合照片 |
| 强调色（`--focus-ring` 等） | 从照片提取 1 个最高饱和度颜色 |

浅色变体是唯一需要重点验证对比度的路径，验收时必须对实际生成的主题跑对比度检查。

### 数据流与 IPC

- 主进程沿用现有设置服务（`readAppSettings` / `publicAppSettings` / `saveAppSettings`，main.js 约 1134–1150 行）：`app-settings.json` 新增 `theme` 字段（`'classic'` 或 `'photo'`）与 `themePalette`（生成的调色板 JSON）。
- 照片文件持久化到 `userData/photo-theme.jpg`，完全参照现有 `mirrorImagePath` / `chooseMirrorImage` 的校验、JPEG 转换与写入模式（main.js 约 1308 行）。
- 新增 IPC（走 `preload.js` contextBridge，窄接口）：
  - `settings:set-theme`（`{ theme, palette? }`）→ 校验后保存并广播 `settings:changed`。
  - `theme:get-photo`（返回照片 dataUrl 供设置页预览与衬底渲染）。
- 渲染层应用：`document.documentElement` 上设 `data-theme="photo"` + 以 CSS 变量方式注入 `themePalette`（`style.setProperty` 循环或一个 `<style>` 块）。经典黑 = 无属性 = 现有 `:root` 原值。
- **防首帧闪烁**：主题在渲染层同步读 LocalStorage 缓存立即应用，再与主进程 `settings:get` 对账修正；切换主题时写回缓存。
- **通知窗口联动**：notification 窗口同样应用主题（同一套注入逻辑放进 notification.html/js），保证多窗口视觉一致。
- 宠物覆盖窗口（见功能二）同样注入 —— 这是「换肤即换宠」的实现基础。

---

## 功能二：AI 桌宠

### 产品范围

- 默认开启的桌面宠物：在桌面上自由走动、偶尔停留 / 休息，可点击。
- 单击宠物 → 头顶气泡弹出输入框，快问快答（一次一个问题）。
- 双击宠物 → 展开主面板并切到「宠物」页：完整对话历史、记忆条目管理（查看 / 添加 / 删除 / 清空）。
- L2 事件联动：Codex / Claude / GPT 任务完成 → 欢呼 + 气泡；番茄钟结束 → 庆祝；待办到期提醒 → 提示动作。事件提示不打断正在进行的输入。
- 未配置 API Key：宠物正常走动与事件反应，气泡显示「未配置」引导跳转设置页 API 卡片。

### 窗口架构（关键设计）

新增 `createPetWindow()`，参照 `createTaskNotificationWindow`（main.js 约 703 行）的骨架，但形态为**整屏透明覆盖窗口**：

- `transparent: true` + `backgroundColor: '#00000000'`、`frame: false`、`skipTaskbar: true`、`hiddenInMissionControl: true`、`hasShadow: false`、`roundedCorners: false`、`visibleOnAllWorkspaces`。
- **窗口边界创建后永不变化**（符合项目「窗口边界零动画」防卡顿铁律）：覆盖宠物所在屏幕整屏，宠物的一切移动都是窗口内的 CSS transform，由合成器层完成。
- **点击穿透**：默认 `setIgnoreMouseEvents(true, { forward: true })`；渲染层监听 `mousemove` 命中检测宠物身体包围盒时，经 IPC 临时恢复 `setIgnoreMouseEvents(false)`，离开后归还。这是整屏覆盖不挡桌面的标准做法。
- **层级**：`setAlwaysOnTop(true, 'screen-saver', 0)` —— 低于主面板与通知窗口的 level 1，面板展开时视觉与点击都在宠物之上。
- **多屏**：锚定主面板当前所在屏（沿用项目 `getDisplayMatching` 惯例，绝不跟随光标）；屏幕变化时整体重建覆盖窗口。
- **焦点**：窗口默认 `focusable: false`；气泡打开时 `setFocusable(true)` + `focus()`，气泡关闭（或焦点离开）时 `setFocusable(false)` 归还。主面板失焦自动收起是既有行为，不做特殊处理。
- Windows 10/11 同代码可用（透明覆盖 + forward 穿透在双平台均支持），遵守项目双平台约束。

### 形象与动效

- 纯 CSS/SVG 矢量宠物（新增 `renderer/pet.html` / `pet.css` / `pet.js`），无图片素材依赖。
- 配色全部引用主题 CSS 变量，随换肤联动。
- 状态机：`idle`（呼吸 / 眨眼）→ `walk`（沿桌面底边或安全区域漫步）→ `rest`（偶尔停下休息）；走动避开屏幕边缘安全距。
- 单击 / 双击区分用约 250ms 去抖。
- `prefers-reduced-motion` 必须降级（静止或最小幅度），沿用项目动效降级惯例。

### 对话与记忆

- **LLM 通道完全复用现有 DeepSeek 基础设施**：`resolveLlmConfig`（main.js 约 2517 行，`safeStorage` 加密 Key、baseUrl / model 可配）与 `smart:organize-material`（约 1843 行）的 fetch 调用形态。**不新增第二份 API Key 配置**；设置页 API 卡片的 DeepSeek 状态即桌宠大脑状态。
- 新增 IPC：`pet:chat`（`{ message }`）→ 主进程组装上下文调用 LLM → 返回 `{ reply }` 或结构化错误（`llm_not_configured` 等）。第一版非流式即可，气泡内打字机效果由渲染层模拟。
- 上下文组装：系统提示（宠物人设）+ 长期记忆条目 + 最近对话窗口。
- **记忆持久化**：`userData/pet-memory.json`，主进程读写（渲染层不碰文件系统）：

```json
{
  "conversations": [{ "id": "...", "role": "user|assistant", "content": "...", "ts": 0 }],
  "longTerm": [{ "id": "...", "content": "...", "ts": 0, "source": "manual" }]
}
```

- 上限截断：对话保留最近 200 条、长期记忆 50 条，超出淘汰最老（截断逻辑做成 `main-services.js` 纯函数以便单测）。
- 长期记忆第一版由用户在「宠物」页手动添加 / 删除；由对话自动提炼记忆可作为后续迭代。

### 事件联动接线

主进程在现有事件出口处同步转发给宠物窗口（`petWindow.webContents.send`）：任务完成通知（`task-notification:show` 出口）、番茄钟（`pomodoro:notify` 出口）、待办提醒（`todo:reminded` 出口）。宠物窗口收到后播放对应动作 + 气泡文案（气泡文案走渲染层文案表，不进主进程）。

### 设置页与 Tab 改动

- 设置页新增「桌宠」卡片：开关（默认开）、尺寸（S / M / L）、「清空对话与记忆」入口。
- 主面板新增「宠物」Tab：仅在桌宠开启时可见（`ALL_TABS` 与 `applyFeatureSettings` 相应扩展，app.js 约 722–742 行）；页内含对话历史列表、输入框（复用待办输入框的输入法组合态处理经验：`isComposing` / keyCode 229 不提交）、记忆条目管理。
- 「宠物」Tab 打开时同步拉取 `pet:get-memory`；气泡与面板页共用同一个对话模块，只是两个视图容器。

---

## 定稿交互规格

| 场景 | 行为 |
| --- | --- |
| 面板收起（常态），点宠物 | 头顶气泡弹出，快问快答 |
| 双击宠物 / 气泡上的「历史」按钮 | 展开面板进「宠物」页 |
| 聊天中途点刘海展开面板 | 气泡礼貌收起，上下文已保存，下次点开接着聊 |
| 任务完成 / 番茄钟 / 待办提醒 | 宠物欢呼 / 庆祝 / 提醒动作 + 气泡提示，不打断输入 |
| 未配置 API Key | 宠物正常活动与事件反应；气泡显示「未配置」引导去设置页 |
| 换肤 | 面板、通知窗口、宠物配色同步切换 |
| 上传照片生成主题 | 预览色板 → 应用 → 持久化；「恢复默认」回到经典黑 |

---

## 实施顺序

1. **照片主题**：色板提取 + token 映射 + 设置页外观卡片 + 持久化 + 防闪帧（桌宠配色依赖它，先做）。
2. **桌宠骨架**：覆盖窗口 + 矢量形象 + 走动状态机 + 点击命中穿透。
3. **事件联动**：接 task-notification / pomodoro / todo 事件出口。
4. **对话 + 记忆**：`pet:chat` IPC + `pet-memory.json` + 气泡与「宠物」页。
5. **收尾**：更新测试、`npm test` 回归、经典黑与照片主题双主题截图验证、浅色路径对比度实测。

每步完成后跑 `npm test`，不允许带病进入下一步。

## 工程约束（必须遵守）

- 遵守 AGENTS.md / CLAUDE.md 全部 NEVER 规则：渲染进程不 `require('electron')`、IPC 只走 `preload.js` contextBridge、不硬编码颜色 / 字号 / 间距（新样式一律用 CSS 变量）、摄像头与麦克风与本功能无关不得引入。
- 主进程文件 camelCase、常量大写下划线；渲染逻辑全部放 `renderer/`；纯领域逻辑（主题校验、记忆截断）放 `main-services.js` 供单测。
- UI 内不使用 emoji，图标用内联 SVG（`currentColor`）。
- 测试更新：`tests/renderer-structure.test.js` 补新设置卡与宠物页结构断言；`tests/main-services.test.js` 补主题校验与记忆截断；**不得破坏既有断言**（如 home-module 开关的精确列表）。
- 推送 GitHub 前按仓库规则联动检查版本号、`CHANGELOG.md`、README 与下载入口；打包发布必须用户明确确认。

## 验收标准

1. 经典黑默认主题与改造前像素级一致（`:root` 原值零改动）。
2. 上传照片 → 生成主题 → 面板 / 通知窗口 / 宠物同步换肤；重启后主题保持且无首帧闪烁；「恢复默认」有效。
3. 生成的浅色主题正文文本对比度由代码实算 ≥ 4.5:1（报告实际数值，不宣称）。
4. 宠物默认出现并自由走动；整屏覆盖窗口不影响桌面、刘海面板、通知窗口的任何点击；`prefers-reduced-motion` 下降级。
5. 单击气泡问答、双击进「宠物」页、聊天中途展开面板气泡礼貌收起、三类事件联动动作、未配置 Key 的引导，全部按交互规格表工作。
6. 对话与记忆持久化到 `userData/pet-memory.json`，重启不丢；截断上限生效。
7. `npm test` 全绿；macOS 与 Windows 行为路径均已考虑。

---

# 实施记录（2026-09-20）

## 已交付

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 主题 | `renderer/theme.js` | 照片色板提取（canvas 降采样 + k-means 量化）、WCAG 对比度实算与自动校正、三套 surface 的变量注入 |
| 主题 | `renderer/theme-boot.js` | 启动自举：同步读 LocalStorage 缓存先上色，再由主进程设置对账，消除首帧闪黑 |
| 主题 | `renderer/pet-panel.js` | 外观卡片、桌宠卡片、宠物页（对话 + 记忆）的全部接线 |
| 桌宠 | `renderer/pet.html` / `pet.css` / `pet.js` | 整屏透明覆盖页、矢量猫形团子、idle/walk/rest 状态机、气泡对话、命中穿透、reduced-motion 降级 |
| 主进程 | `main.js` | 主题设置与照片存储 IPC、桌宠覆盖窗口、`pet-memory.json` 读写、`pet:chat` 调 LLM、事件联动单点接入、多屏重定位 |
| 纯领域 | `main-services.js` | 调色板校验、主题回落、桌宠设置/位置归一化、记忆截断、对话上下文组装 |
| 桥接 | `preload.js` | 主题与桌宠窄接口（不暴露原始 IPC） |
| 界面 | `renderer/index.html` / `styles.css` | 外观卡片、桌宠卡片、「宠物」Tab 与页面；通知窗口主题联动 |

## 与计划的偏差（均为实施中发现的必要调整）

1. **新增 `--overlay-rgb` 叠加通道变量**（计划外）：`styles.css` 原有 155 处硬编码 `rgba(255,255,255,α)` 叠加层。黑玻璃下无碍，但照片生成浅色主题时白色叠加会糊在浅底上。改为 `rgba(var(--overlay-rgb), α)`，经典黑取值逐字不变（已用规范化 diff 验证等价），浅色主题把通道整体翻成黑色。这是「保留原样式 + 浅色照片可用」两个要求同时成立的前提。
2. **照片存工作区目录而非 `userData`**：与镜像封面一致（`workspacePath(PHOTO_THEME_FILE)`），并加入工作区迁移复制清单；默认工作区就是 `userData`，行为等价。
3. **设置页两列改为各自滚动**：原有两列是「固定首行 + 1fr」的填充式网格，新增两张卡片后内容必然溢出。改为 `grid-auto-rows: min-content` + 列内滚动，卡片视觉不变。
4. **「宠物」纳入默认展开页候选**：`DEFAULT_PANEL_TABS` 增加 `pet`，并在主进程把 `pet.enabled` 折算进默认页有效性判定（关闭桌宠后默认页自动回落首页）。对应更新了既有测试的精确列表断言，保持「每个面板 Tab 都能设为默认展开页」这条不变量成立。
5. **桌宠事件联动只用单点接入**：在 `enqueueTaskNotification` 去重通过之后统一触发，而不是分别在待办 / 番茄钟处发；避免重复提醒重复播放动作，且覆盖 codex / claude / gpt 全部来源。
6. **桌宠窗口层级为 `screen-saver` level 0**，低于主面板与提醒窗口的 level 1，保证面板展开与提醒弹出永远在宠物之上。
7. **`scripts/test-desktop.js` 的 `node --check` 清单**补入 4 个新渲染层文件。

## 实施中发现并修复的问题

1. **启动对账会把照片主题清回经典黑**（已修 + 已加运行时回归测试）：主进程 `settings:get` 回传的键名是 `themePalette`，而 `theme-boot.js` 最初只读 `palette`，导致每次启动对账都判定为无可用色板并 `clear()`。现在两个键名都接受，并由 `tests/theme-boot.test.js` 在 vm 沙箱里真实执行启动逻辑来守住这条路径。
2. **桌宠初始位置的默认值两侧不一致**（已修）：`y` 的语义是「0 = 屏幕底部安全线，1 = 竖直活动带顶端」，渲染层默认 0.12，主进程曾默认 0.86，会让首次启动的桌宠飘高一截。已统一为 0.12。

## 验证状态

- `node --test tests/*.test.js`：**144 项全部通过**（新增 19 项：`main-services` 7 项 + `renderer-structure` 6 项 + `theme-boot` 6 项）。
- `node --check`：全部新增与改动文件通过。
- 主题对比度由 `theme.js` 运行时实算，深色样例 `text1/bg 16.46:1`、浅色样例 `text1/bg 15.28:1`，非写死数值。
- 静态交叉校验：新增脚本引用的 17 个 DOM id 全部存在；preload 暴露的 67 个 invoke/send 通道在主进程全部有对应 handler；新增 CSS 类名全部有定义；三份 CSS 花括号平衡。

### 集成测试结果

Electron 二进制已通过 npmmirror 镜像手动装入（`node_modules/electron`，44.0.0），三个真实启动测试的实跑结果：

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| `tests/startup.electron.js` | **通过** | 最关键的一项：真实启动 `main.js`、加载面板页与默认创建的桌宠窗口，断言**所有渲染进程零 console error** 并校验工作区恢复。说明新增的 `theme.js` / `theme-boot.js` / `pet-panel.js` / `pet.html` / `pet.js` 在真实运行时都不报错。 |
| `tests/retained-workspace.electron.js` | **通过** | 工作区数据保留路径未受影响。 |
| `tests/notch-focus.electron.js` | **本机环境受阻** | 该测试在本沙箱里无法稳定运行：Electron 的 GPU 进程无法初始化（`sandbox initialization failed` / `GPU process isn't usable`）。禁用 GPU 时面板展开卡在两次 `requestAnimationFrame` 上（985 行），强制 SwiftShader 后推进到汽水音乐 canvas 特效断言（1056 行，`effectRunning` 因特效从未启动而未置位）。这两处都属于 GPU / canvas / 合成器依赖，与本次改动无关；本文件只做了**一处必要更新**：默认展开页选项数 `8 → 9`（新增「宠物」Tab 带来的真实产品变化）。 |

`scripts/test-desktop.js` 在本环境会因上述原因退出非零，属于环境限制，不是本次改动引入的失败；在没有 GPU 沙箱限制的机器上应完整重跑一次确认。

## 后续可选迭代（本次未做）

- 「照片作为面板衬底」开关（设计文档中列为可选，已预留 `themePalette` 与预览图数据流）。
- 由对话自动提炼长期记忆（当前只支持手动新增 / 删除）。
- 桌宠竖直活动范围目前限制在屏幕底部约 30% 区域，若需爬得更高，调整 `renderer/pet.js` 的 `VERTICAL_BAND` 常量即可。

---

# 桌宠形象 v2：像素风小恐龙（2026-09-20，应用户要求）

用户决策：参考数码宝贝亚古兽、像素风、尺寸要更小。考虑到本仓库是公开的 MIT 项目，
精灵做成了「亚古兽风格的原创像素小恐龙」——配色、轮廓、獠牙笑容等辨识点都对上，
但代码与文案中不使用「亚古兽 / Agumon」命名，避免角色版权问题。

## 视觉规格

- **画布**：24 x 28 像素网格（上方 4 行为头顶特效区），CSS `image-rendering: pixelated`
  整数倍放大（2x / 3x / 4x），任何缩放档位都保持硬边像素。
- **配色（角色身份色，固定不随主题漂移）**：深棕轮廓 `#2A1A10`、橙身 `#F5822D`、
  亮橙高光 `#FFAB5E`、奶油肚皮 `#FFE3B0`、绿眼 `#3FB54A`、白爪/牙 `#FFFFFF`、
  嘴腔暗红 `#8C3B2E`、地面影暗橙 `#C25E12`、提醒红 `#E8534A`。
- **辨识点**：大脑袋约占身高一半、颅顶双耳突、绿眼黑瞳、咧嘴獠牙大笑（暗红嘴腔 +
  两侧各 2px 白獠牙）、三爪手、三爪脚、体侧厚尾（转身随画布镜像换边）。
- **实现**：`renderer/pixel-pet.js` 以「左半 12 列 + 镜像」定义精灵，天然对称；
  尾巴等不对称细节用覆盖像素。帧构建全部是纯函数，可在 Node 里逐像素断言。

## 帧与动作

| 状态 / 事件 | 帧 | 节奏 |
| --- | --- | --- |
| 静息 | base（呼吸下沉由 CSS 动画承担） | 随机眨眼 140ms，间隔 3-6s |
| 眨眼 | blink（绿眼归零，画闭眼横线） | 140ms |
| 走路 | walkA / walkB（左右脚交替抬起 1px） | 170ms/帧，配 CSS 弹跳 |
| 歇息 | rest（头下移 3 行、收腿、闭眼坐姿） | 呼吸 1100ms；头顶漂 Z（亮 1.2s 歇 1.2s） |
| 任务完成 | cheer（双臂举过头顶 + 白爪） | CSS 弹跳 ~900ms |
| 番茄钟 | cheer + 四角十字像素闪光（两两交替） | ~1400ms |
| 待办提醒 | base + 红色「!」（2x3 竖条 + 圆点） | CSS 左右抖动 ~800ms |

朝向翻转并入舞台 transform（`translate3d(x,-y,0) scaleX(±1)`），
转身自带平滑压缩过渡；`.pet-body` 上的动作动画不再与翻转冲突。

## 尺寸

48 / 72（默认）/ 96 px，取代旧版 96 / 132 / 176——默认尺寸缩小约 45%。
画布按 24x28 比例设定舞台高度（`calc(var(--pet-size) * 28 / 24)`）。

## 验证方式（本模型无法查看图片，全靠像素级程序校验）

- `tests/pixel-pet.test.js`（7 项）：24x28 契约、亚古兽辨识点逐像素断言
  （绿眼坐标、獠牙位置、爪色、双腿间隙、尾巴）、眨眼帧仅眼部 6 像素变化、
  踏步帧头部完全不动、坐姿收腿闭眼、欢呼举臂、色板固定。
- Electron 实跑校验：页面加载零 console error；逐帧 `getImageData`
  统计调色板命中（如眨眼帧绿像素必须为 0、感叹号帧红像素必须为 8）。
- 预览图经页面内 `canvas.toDataURL` 导出（不用 `capturePage`，不触发
  macOS 屏幕录制授权），存于 `docs/screenshots/pet-pixel-sprites.png`，
  审美由用户过目。

---

# 桌宠形象 v3：小贝（布偶猫，2026-09-20，应用户提供的素材）

用户反馈像素小恐龙「有点丑丑的」，并提供了其另一应用的完整形象素材。
素材统一收进 `renderer/assets/pet/`（12 组 84 帧，256x256 RGBA，约 3.5MB），
`PettingClassic`（6 帧旧版画风）保留为备用、未映射。

## 素材分析结论（程序化：形心漂移 / 包围盒 / 主色 / 对称度）

- 主色奶油白 `#f8f8e8` + 暖奶 `#f8e8d8` + 描边黑，布偶猫配色；
- Idle 12 帧几乎静止（呼吸微动），Petting 运动幅度最大（形心漂移 25x39px），
  Sleepy 仅 4 帧且包围盒缩至 165px（蜷缩姿态、对称度 75%）；
- 整体对称度约 61%：正面朝向但存在单侧细节，朝向翻转保留。

## 动作映射（优先级：摸头 > 事件动作 > 气泡状态 > 行走相位）

| 触发 | 动画 | 帧数@fps | 播法 |
| --- | --- | --- | --- |
| 静息 / 走路（位移由 CSS 承担） | Idle | 12@6 | 循环 |
| 歇息 | Sleepy | 4@3 | 循环 |
| 单击宠物 | Petting | 12@10 | 单次 1.2s，随后接气泡状态 |
| 任务完成 | Success | 6@10 | 单次 |
| 番茄钟 / 对话回复 | Satisfied | 6@8 | 单次 |
| 待办提醒 / 未配置 / 出错 | Uncertain | 6@8 | 单次 |
| 对话思考中 | Thinking | 6@6 | 循环 |
| 气泡等待输入 | Waiting | 6@6 | 循环 |
| 双击打开面板 | Guiding | 6@10 | 单次 |
| Scan / CabinetWatch / PettingClassic | 备用 | — | 未映射，留作后续 |

## 实现与验证

- 播放器：`pet.js` 内 `PET_ANIMS` 映射表 + 60ms ticker；`<img>` 换帧
  （平滑插画，弃用 `image-rendering: pixelated`），启动时预载全部映射帧。
- 尺寸三档 64 / 96（默认）/ 128；舞台回正方形（素材 256x256）。
- v2 像素小恐龙（pixel-pet.js）整体移除。
- 验证（本模型无法看图，全部程序化）：Electron 实跑零 console error；
  1.5s 采样确认 Idle 按序循环；点击后确认 Petting 12 帧完整播放并自动衔接
  Uncertain（气泡未配置态）；映射预览图经 `canvas.toDataURL` 导出存于
  `docs/screenshots/pet-xiaobei-mapping.png` 供用户审阅。
- 测试：素材清单逐帧存在性断言 + 播放器接线断言（renderer-structure），
  全量 146 项通过；startup 集成测试通过。

## v3 修订：移动与小动作（用户反馈「动的时候还是保持坐下的样子」）

根因：素材库 12 组动画**全部是原地动作**（Idle 形心漂移仅 1px，是坐姿呼吸），
没有任何走路帧。行走相位直接拿 Idle 帧平移，于是出现「坐着的猫贴地滑行」。

1. **蹦跳移动**：`.pet-stage[data-state='walk']` 改用 `pet-hop` 关键帧
   （蓄力压扁 → 跃起伸展 → 落地压扁，带 ±2° 摇晃），跳跃高度由
   `--pet-hop-distance: calc(var(--pet-size) * 0.16)` 派生，随尺寸自适应。
   这是没有走路帧时桌面宠物的标准解法。
2. **静息小动作**：把原本闲置的 `Scan`、`CabinetWatch`、`Waiting` 纳入
   `PET_ANIMS`，作为小动作池（`FIDGET_ANIMS`）。静息相位持续时每 9-16 秒
   随机挑一个播一遍再回到 Idle，解决「看起来像静止图片」。优先级仍在
   事件动作与气泡状态之下。
3. **打盹时长**：`MIN_REST_MS`/`MAX_REST_MS` 由 1-4s 调整为 2.5-7s，
   蜷缩的 Sleepy 姿态需要停留够久才读得出来。

验证：Electron 实跑零 console error；走路状态计算样式为 `pet-hop`、
静息为 `pet-breathe`；12 秒采样确认小动作帧真实出现（两次运行分别命中
scan 与 waiting，随机池生效）；146 项测试与 startup 集成测试全部通过。

> 若后续拿到小贝的走路帧素材，只需加入 `PET_ANIMS.walk`、在
> `pickPetAnimation` 的行走相位返回它，并去掉 `pet-hop` 动画即可。

---

# 桌宠窗口形态 v4：小窗口（2026-09-21）

## 问题

用户反馈「点击不了宠物」。实测窗口顺序（CGWindowList，z 越小越靠前）：

```
z=17  layer 0  DSH Desktop   24,43    1380x860
z=18  layer 0  网易云音乐     -191,229 1057x752
z=19  layer 0  TO-DO Panel    0,33     1470x865   ← 宠物（全屏透明覆盖层）
```

宠物窗口虽在 layer 0（普通层级，符合「不要压在所有窗口之上」），但它是**全屏覆盖层**，
被用户的两个窗口整片盖住 —— 于是既看不见也点不到。这是「桌面层 + 全屏覆盖」的必然结果：
只要开着窗口，覆盖层就在后面。而 macOS 真正的桌面背景层 `type: 'desktop'`
（Electron 官方文档：desktop window will not receive focus, keyboard or mouse events）
连鼠标事件都收不到，宠物会彻底无法交互。

## 结论：小窗口是唯一兼顾两者的形态

窗口 = 宠物本身（282×120，随尺寸档位变化），`alwaysOnTop: true, 'floating'`：

- 任何时候都看得见、点得到、拖得动 ✓
- 只占一小块地方，不遮挡内容 ✓
- 不覆盖全屏应用（`visibleOnFullScreen: false`），随 Space 切换 ✓
- 空白处仍然鼠标穿透（`setIgnoreMouseEvents(true, {forward:true})` + 渲染层命中检测）✓

## 实现要点

- **移动即移动窗口**：`state.x/state.y` 改为「窗口左上角的屏幕坐标」，走动与拖拽都通过
  `pet:move` 交给主进程 setBounds（节流 33ms，拖拽时立即）。活动范围 = 屏幕工作区 − 窗口尺寸。
- **气泡按需加高**：`pet:set-chrome` 上报气泡/提示卡需要的空间，主进程向上加高窗口
  （保持窗口底边不动 → 宠物屏幕位置不变）。长回复在气泡内滚动（7 行上限）。
- **拖拽必须换算屏幕坐标**：窗口跟着指针走，`clientX` 不再单调变化，
  但 `screenX = 窗口 x + clientX` 在全程都稳定（窗口移动时 clientX 同步反向补偿）。
- **采纳主进程返回的位置**：加高窗口或贴边裁剪都会移动窗口，渲染层必须采纳
  `pet:move` / `pet:set-chrome` 返回的 bounds，否则下一次推送会把窗口拽回旧坐标
  （表现为宠物位置漂移、拖拽跳变）。换屏重定位后同样重新下发配置。
- 删除 `applyPetTransform`（不再需要 CSS 位移），朝向翻转改用舞台 transform。

## 实测（真实启动 main.js）

| 检查 | 结果 |
| --- | --- |
| 窗口尺寸 | 282×120（屏幕 1470×866），小窗口 ✓ |
| 层级 | floating ✓ |
| 拖拽 | 请求 (60,−36) → 实测 **(60,−36)**，1:1 ✓ |
| 点击 | 气泡打开 ✓，窗口向上加高 ✓ |
| 走路 | 窗口随宠物移动 ✓ |
| console error | 0 ✓ |

## 音乐模块：汽水音乐 → 网易云音乐

同一轮改动：`MUSIC_APPS` 按安装情况自动选择客户端（优先网易云音乐 `/Applications/NeteaseMusic.app`
`com.netease.163music`，其次汽水音乐），界面名称由 `music:status` 下发的 `label` 决定；
快捷键固定为 空格播放/暂停、⌘←/⌘→ 切歌。实测 `music:status` 返回
`{installed:true, label:"网易云音乐", icon:<已加载>}`。

> 若你的网易云客户端改过快捷键，改 `main-services.js` 的 `musicShortcutSpec()` 一处即可。
