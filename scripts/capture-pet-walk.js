'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outputDir = path.join(root, 'docs', 'screenshots', 'pet-gait');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 300,
    show: false,
    frame: false,
    backgroundColor: '#303030',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await window.loadFile(path.join(root, 'renderer', 'pet.html'));
  await wait(150);
  await fs.mkdir(outputDir, { recursive: true });

  for (const size of ['small', 'medium', 'large']) {
    await window.webContents.executeJavaScript(`
      updateConfig({
        enabled: true,
        size: '${size}',
        theme: 'classic',
        motion: { x: 0.1, y: 0.1, facing: 1 }
      });
      // 验收截图必须比较同一动作、同一帧。停止自主状态机和序列播放器，
      // 避免等待截图期间随机切回 Idle / Sleepy 或走到终点。
      state.loopActive = false;
      state.speed = 0;
      state.pendingWalk = null;
      spritePlayer.fidget = null;
      spritePlayer.pettingUntil = 0;
      spritePlayer.guidingUntil = 0;
      spritePlayer.satisfiedUntil = 0;
      spritePlayer.uncertainUntil = 0;
      stopSpriteTicker();
      setPhase('walk');
      placePet(80, 40);
      spriteGhost.removeAttribute('src');
      spriteGhost.style.opacity = '0';
      spriteImg.style.opacity = '1';
      spriteImg.src = petFrameSrc('walk', 2);
      spriteImg.decode();
    `);
    await wait(120);
    const image = await window.capturePage();
    await fs.writeFile(path.join(outputDir, `runtime-${size}.png`), image.toPNG());
  }

  await window.webContents.executeJavaScript(`
    updateConfig({ enabled: true, size: 'large', theme: 'classic', motion: { x: 0.1, y: 0.1, facing: 1 } });
    state.loopActive = false;
    state.speed = 0;
    spritePlayer.fidget = null;
    stopSpriteTicker();
    setPhase('idle');
    placePet(80, 40);
    spriteGhost.removeAttribute('src');
    spriteGhost.style.opacity = '0';
    spriteImg.style.opacity = '1';
    spriteImg.src = petFrameSrc('idle', 0);
    spriteImg.decode();
  `);
  await wait(120);
  const idleImage = await window.capturePage();
  await fs.writeFile(path.join(outputDir, 'runtime-idle-large.png'), idleImage.toPNG());

  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
