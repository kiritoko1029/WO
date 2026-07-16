(() => {
  'use strict';

  const WIDTH = 1_920;
  const HEIGHT = 1_080;
  const FRAME_INTERVAL_MS = 1_000 / 60;
  const canvas = document.getElementById('motion');
  const context = canvas.getContext('2d', { alpha: false });
  const title = new URLSearchParams(location.search).get('title');
  if (title) document.title = title;

  let frame = 0;
  let nextFrameAt = performance.now();

  const drawFineDetail = (offset) => {
    context.save();
    context.font = '18px Consolas, monospace';
    context.textBaseline = 'top';
    for (let row = 0; row < 24; row += 1) {
      const y = 86 + ((row * 39 + offset) % 936);
      context.fillStyle = row % 2 === 0 ? '#f4f7f8' : '#8ee3c1';
      context.fillText(
        `ROW ${String(row).padStart(2, '0')} | ` +
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 <>[]{} /\\ '.repeat(3),
        24,
        y,
      );
    }
    context.restore();
  };

  const draw = () => {
    const phase = frame / 60;
    const horizontal = Math.round((frame * 11) % WIDTH);
    const vertical = Math.round((frame * 7) % HEIGHT);

    context.fillStyle = '#101418';
    context.fillRect(0, 0, WIDTH, HEIGHT);

    context.fillStyle = frame % 120 < 60 ? '#0f6b78' : '#7e3257';
    context.fillRect(horizontal - WIDTH, 0, WIDTH * 1.35, HEIGHT);
    context.fillStyle = frame % 90 < 45 ? '#d1f05c' : '#43b7ff';
    context.fillRect(WIDTH - horizontal, 0, WIDTH * 1.35, HEIGHT);

    const bandY = Math.round(HEIGHT / 2 + Math.sin(phase * 2.3) * 330);
    context.fillStyle = '#f44b52';
    context.fillRect(0, bandY - 120, WIDTH, 240);
    context.fillStyle = '#181c21';
    context.fillRect(0, bandY - 18, WIDTH, 36);

    context.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    context.lineWidth = 1;
    for (let x = -vertical; x < WIDTH; x += 24) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 540, HEIGHT);
      context.stroke();
    }

    drawFineDetail((frame * 5) % 936);

    context.fillStyle = 'rgba(0, 0, 0, 0.86)';
    context.fillRect(0, 0, WIDTH, 70);
    context.fillStyle = '#ffffff';
    context.font = 'bold 32px Consolas, monospace';
    context.textBaseline = 'middle';
    context.fillText(
      `WO 1080p60 | FRAME ${String(frame).padStart(10, '0')} | ${new Date().toISOString()}`,
      24,
      35,
    );

    context.fillStyle = '#ffffff';
    context.fillRect(WIDTH - 244, HEIGHT - 164, 220, 140);
    context.fillStyle = '#000000';
    context.fillRect(WIDTH - 230, HEIGHT - 150, 192, 112);
    context.fillStyle = frame % 2 === 0 ? '#ffffff' : '#000000';
    context.fillRect(WIDTH - 214, HEIGHT - 134, 160, 80);
  };

  const tick = (now) => {
    requestAnimationFrame(tick);
    if (now + 0.25 < nextFrameAt) return;

    const elapsedFrames = Math.max(
      1,
      Math.floor((now - nextFrameAt) / FRAME_INTERVAL_MS) + 1,
    );
    frame += elapsedFrames;
    nextFrameAt += elapsedFrames * FRAME_INTERVAL_MS;
    draw();
  };

  Object.defineProperties(globalThis, {
    __WO_MOTION_READY: { value: true, writable: false },
    __WO_MOTION_DIMENSIONS: {
      value: Object.freeze({ width: WIDTH, height: HEIGHT, fps: 60 }),
      writable: false,
    },
    __WO_MOTION_FRAME: { get: () => frame },
  });

  draw();
  requestAnimationFrame(tick);
})();
