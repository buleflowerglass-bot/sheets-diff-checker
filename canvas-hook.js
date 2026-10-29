// canvas-hook.js - 运行在 MAIN 环境，被动监听行号 Y 坐标与原生字号
(function () {
  let tracking = false;
  let yMap = {};
  let drawTimer = null;
  let canvasTopOffset = 0;

  let fsMap = {};
  let fsThrottle = null;

  window.addEventListener('GS_START_TRACKING', () => { tracking = true; fsMap = {}; });
  window.addEventListener('GS_STOP_TRACKING', () => { tracking = false; yMap = {}; fsMap = {}; });

  const origFillText = CanvasRenderingContext2D.prototype.fillText;

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    // 1. 无脑放行原本的所有绘制逻辑，绝不干预原生样式
    origFillText.apply(this, arguments);

    if (!tracking || !this.canvas) return;

    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return;

    const m = this.getTransform();
    const absX = m.e + x;
    const absY = m.f + y;

    // 2. 窃听行号的 Y 坐标
    if (absX < 60 && /^\d+$/.test(t)) {
      if (!drawTimer) {
        canvasTopOffset = this.canvas.getBoundingClientRect().top;
        drawTimer = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('GS_Y_MAP', { detail: { yMap } }));
          yMap = {};
          drawTimer = null;
        }, 30);
      }
      yMap[t] = canvasTopOffset + absY;
    } 
    // 3. 窃听数据单元格的字体大小 (排除行号区域)
    else if (absX > 60 && t.length > 0) {
      if (this.font) {
        const match = this.font.match(/(\d+(?:\.\d+)?)px/);
        if (match) {
          const fs = parseFloat(match[1]);
          if (fs > 8 && fs < 100) { // 剔除异常字号
            fsMap[fs] = (fsMap[fs] || 0) + 1;
            
            if (!fsThrottle) {
              // 防抖：每 200ms 统计一次屏幕上最主流的字号并广播
              fsThrottle = setTimeout(() => {
                let bestFs = 13;
                let maxCount = 0;
                for (const key in fsMap) {
                  if (fsMap[key] > maxCount) {
                    maxCount = fsMap[key];
                    bestFs = parseFloat(key);
                  }
                }
                window.dispatchEvent(new CustomEvent('GS_FONT_SIZE', { detail: bestFs }));
                fsMap = {};
                fsThrottle = null;
              }, 200);
            }
          }
        }
      }
    }
  };
})();