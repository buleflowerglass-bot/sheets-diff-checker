(function () {
  let hidePanelOnEdit = true;
  let autoRecompare = true;
  let isSuppressedByScroll = false;
  let isHoveringPanel = false;
  let isHoveringToolbar = false;
  let wasEditing = false;
  let autoRecompareTimer = null;
  let lastCompareParams = null;

  let editCheckTimer = null;
  let currentDetectedFontSize = 13;
  let currentComparingGid = null;

  let currentPanelWidth = parseInt(localStorage.getItem('gs_custom_panel_width'), 10) || 580;
  let isResizingWidth = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let latestVisibleEntries = [];

  const rowHeightCache = {};

  function colLetterToIndex(colStr) {
    const clean = (colStr || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(clean)) return -1;
    let idx = 0;
    for (let i = 0; i < clean.length; i++) {
      idx = idx * 26 + (clean.charCodeAt(i) - 64);
    }
    return idx - 1;
  }

  function getCurrentActiveGid() {
    const activeTabEl = document.querySelector('.docs-sheet-active-tab');
    if (activeTabEl) {
      const dataId = activeTabEl.getAttribute('data-id') || activeTabEl.id?.replace('sheet-button-', '');
      if (dataId && /^\d+$/.test(dataId)) return dataId;
    }
    const gidMatch = window.location.href.match(/[#&?]gid=([0-9]+)/);
    return gidMatch ? gidMatch[1] : '0';
  }

  function getSheetParams() {
    const url = window.location.href;
    const idMatch = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    const activeGid = getCurrentActiveGid();
    return { spreadsheetId: idMatch ? idMatch[1] : null, gid: activeGid };
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let current = '';
    let insideQuote = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"') {
        if (insideQuote && next === '"') {
          current += '"'; i++;
        } else insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        row.push(current); current = '';
      } else if ((char === '\r' || char === '\n') && !insideQuote) {
        if (char === '\r' && next === '\n') i++;
        row.push(current); rows.push(row); row = []; current = '';
      } else current += char;
    }
    if (row.length > 0 || current !== '') { row.push(current); rows.push(row); }
    return rows;
  }

  function tokenize(str, granularity) {
    if (granularity === 'char') return Array.from(str);
    return str.match(/[a-zA-Z\u00C0-\u024F\u0400-\u04FF0-9_]+|[\u4e00-\u9fa5]|[^\s\w\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fa5]|\s/g) || [];
  }

  function computeDirectedDiff(raw1, raw2, granularity) {
    const s1 = (raw1 || '').replace(/\r\n/g, '\n').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ');
    const s2 = (raw2 || '').replace(/\r\n/g, '\n').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ');

    const t1 = tokenize(s1, granularity);
    const t2 = tokenize(s2, granularity);
    const m = t1.length, n = t2.length;

    let start = 0;
    while (start < m && start < n && t1[start] === t2[start]) start++;
    let end1 = m - 1, end2 = n - 1;
    while (end1 >= start && end2 >= start && t1[end1] === t2[end2]) { end1--; end2--; }

    const tokFlags1 = new Array(m).fill(0);
    const tokFlags2 = new Array(n).fill(0);
    const sub1 = t1.slice(start, end1 + 1);
    const sub2 = t2.slice(start, end2 + 1);
    const subM = sub1.length, subN = sub2.length;

    if (subM > 0 && subN === 0) for (let i = start; i <= end1; i++) tokFlags1[i] = 1;
    else if (subN > 0 && subM === 0) for (let j = start; j <= end2; j++) tokFlags2[j] = 1;
    else if (subM > 0 && subN > 0) {
      const dp = Array.from({ length: subM + 1 }, () => new Uint16Array(subN + 1));
      for (let i = 1; i <= subM; i++) {
        for (let j = 1; j <= subN; j++) {
          if (sub1[i - 1] === sub2[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
          else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      let i = subM, j = subN;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && sub1[i - 1] === sub2[j - 1]) { i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { tokFlags2[start + j - 1] = 1; j--; }
        else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) { tokFlags1[start + i - 1] = 1; i--; }
      }
    }

    const flags1 = [];
    for (let k = 0; k < m; k++) for (let c = 0; c < t1[k].length; c++) flags1.push(tokFlags1[k]);
    const flags2 = [];
    for (let k = 0; k < n; k++) for (let c = 0; c < t2[k].length; c++) flags2.push(tokFlags2[k]);

    return { text1: s1, flags1, text2: s2, flags2 };
  }

  function fetchViaBackground(exportUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'FETCH_SHEET_CSV', url: exportUrl }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response && response.success) resolve(response.data);
        else reject(new Error(response?.error || '拉取数据失败'));
      });
    });
  }

  function escapeHtml(unsafe) {
    return (unsafe || '').toString()
         .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function renderDiffHtml(text, flags, isAdd) {
    if (!text) return '<span style="color:#aaa;font-style:italic;">(空)</span>';
    if (!flags || flags.length !== text.length) return escapeHtml(text);
    
    function isPunct(char) {
      return /[^\s\w\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fa5]/.test(char);
    }

    let html = '';
    let curDiff = flags[0] === 1;
    let curIsPunct = isPunct(text[0]);
    let curStr = text[0];
    const tag = isAdd ? 'ins' : 'del';
    const cls = isAdd ? 'gs-add' : 'gs-del';

    for (let i = 1; i < text.length; i++) {
      const diffFlag = flags[i] === 1;
      const punctFlag = isPunct(text[i]);
      const sameGroup = (diffFlag === curDiff) && (!curDiff || curIsPunct === punctFlag);

      if (sameGroup) {
        curStr += text[i];
      } else {
        html += curDiff ? `<${tag} class="${cls}">${escapeHtml(curStr)}</${tag}>` : escapeHtml(curStr);
        curDiff = diffFlag;
        curIsPunct = punctFlag;
        curStr = text[i];
      }
    }
    if (curStr) {
      html += curDiff ? `<${tag} class="${cls}">${escapeHtml(curStr)}</${tag}>` : escapeHtml(curStr);
    }
    return html;
  }

  function hexToRgba(hex, alpha) {
    let c = (hex || '').replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(217, 48, 37, ${alpha})`;
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
  }

  function applyColors(delColor, addColor) {
    const sidePanel = document.getElementById('gs-side-panel');
    if (!sidePanel) return;
    if (delColor) {
      sidePanel.style.setProperty('--gs-color-del', delColor);
      sidePanel.style.setProperty('--gs-bg-del', hexToRgba(delColor, 0.16));
    }
    if (addColor) {
      sidePanel.style.setProperty('--gs-color-add', addColor);
      sidePanel.style.setProperty('--gs-bg-add', hexToRgba(addColor, 0.16));
    }
  }

  function applyPanelWidth(width) {
    currentPanelWidth = Math.max(360, Math.min(window.innerWidth - 80, width));
    const sidePanel = document.getElementById('gs-side-panel');
    if (sidePanel) sidePanel.style.width = `${currentPanelWidth}px`;
    localStorage.setItem('gs_custom_panel_width', currentPanelWidth);
  }

  function onResizeMouseMove(e) {
    if (!isResizingWidth) return;
    const deltaX = resizeStartX - e.clientX;
    const newWidth = resizeStartWidth + deltaX;
    applyPanelWidth(newWidth);
    if (latestVisibleEntries && latestVisibleEntries.length) {
      adjustCardLayout(latestVisibleEntries);
    }
  }

  function onResizeMouseUp() {
    if (!isResizingWidth) return;
    isResizingWidth = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onResizeMouseMove);
    window.removeEventListener('mouseup', onResizeMouseUp);
  }

  function onResizeMouseDown(e) {
    if (e.button !== 0) return;
    isResizingWidth = true;
    resizeStartX = e.clientX;
    resizeStartWidth = currentPanelWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onResizeMouseMove);
    window.addEventListener('mouseup', onResizeMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }

  function handlePanelWheel(e) {
    if (!e.target.closest('.gs-diff-card')) return;
    handleWheelOnly(e);
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const target = elements.find(el => !el.closest('#gs-side-panel'));
    if (target) {
      const syntheticWheel = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, view: window,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
        shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey
      });
      target.dispatchEvent(syntheticWheel);
    }
    e.preventDefault();
  }

  function buildSideCards(diffData) {
    let sidePanel = document.getElementById('gs-side-panel');
    if (!sidePanel) {
      sidePanel = document.createElement('div');
      sidePanel.id = 'gs-side-panel';
      sidePanel.addEventListener('mouseover', (e) => {
        if (sidePanel.classList.contains('gs-panel-hidden')) return;
        if (e.target.closest('.gs-diff-card')) isHoveringPanel = true;
      });
      sidePanel.addEventListener('mouseout', (e) => {
        if (!e.relatedTarget || !e.relatedTarget.closest('.gs-diff-card')) isHoveringPanel = false;
      });
      sidePanel.addEventListener('wheel', handlePanelWheel, { passive: false });
      document.body.appendChild(sidePanel);
    }
    sidePanel.innerHTML = '';
    applyPanelWidth(currentPanelWidth);

    diffData.forEach(row => {
      const card = document.createElement('div');
      card.className = 'gs-diff-card';
      card.id = `gs-card-${row.rowNum}`;
      card.style.display = 'none';
      
      card.innerHTML = `
        <div class="gs-card-resize-handle" title="按住左右拖动调节卡片宽度"></div>
        <div class="gs-card-header">第 ${row.rowNum} 行</div>
        <div class="gs-card-body">
            <div class="gs-row-del">${renderDiffHtml(row.v1, row.f1, false)}</div>
            <div class="gs-row-add">${renderDiffHtml(row.v2, row.f2, true)}</div>
        </div>
      `;
      const resizeHandle = card.querySelector('.gs-card-resize-handle');
      if (resizeHandle) resizeHandle.addEventListener('mousedown', onResizeMouseDown);
      sidePanel.appendChild(card);
    });
  }

  // 极速重绘
  function executeDiffAndRender(rows) {
    if (!lastCompareParams) return;
    const col1Idx = colLetterToIndex(lastCompareParams.col1);
    const col2Idx = colLetterToIndex(lastCompareParams.col2);

    const diffData = [];
    for (let i = 1; i < rows.length; i++) {
      const val1 = rows[i][col1Idx] !== undefined ? rows[i][col1Idx] : '';
      const val2 = rows[i][col2Idx] !== undefined ? rows[i][col2Idx] : '';
      if (val1 !== val2) {
        const res = computeDirectedDiff(val1, val2, lastCompareParams.granularity);
        diffData.push({ rowNum: i + 1, v1: res.text1, v2: res.text2, f1: res.flags1, f2: res.flags2 });
      }
    }

    buildSideCards(diffData);
    applyColors(lastCompareParams.colorDel, lastCompareParams.colorAdd);
    
    window.dispatchEvent(new Event('scroll'));
  }

  let localTableData = []; 

  async function runComparison(col1Input, col2Input, granularity, colorDel, colorAdd) {
    const col1Idx = colLetterToIndex(col1Input);
    const col2Idx = colLetterToIndex(col2Input);
    if (col1Idx < 0 || col2Idx < 0) throw new Error('列字母无效');

    const { spreadsheetId, gid } = getSheetParams();
    if (!spreadsheetId) throw new Error('无法识别表格 ID');

    currentComparingGid = gid;
    lastCompareParams = { col1: col1Input, col2: col2Input, granularity, colorDel, colorAdd };

    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}&_t=${Date.now()}`;
    const csvText = await fetchViaBackground(exportUrl);

    localTableData = parseCSV(csvText); 
    executeDiffAndRender(localTableData);

    window.dispatchEvent(new CustomEvent('GS_START_TRACKING')); 
    return `提取成功！`;
  }

  function getExactTextFromEditor(editor) {
    if (!editor) return '';
    try {
      const clone = editor.cloneNode(true);
      const hiddens = clone.querySelectorAll('[style*="display: none"], [style*="display:none"], [aria-hidden="true"]');
      hiddens.forEach(n => n.remove());
      let text = clone.textContent;
      text = text.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ');
      if (text.endsWith('\n')) text = text.slice(0, -1);
      return text;
    } catch (e) {
      return editor.innerText.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, ' ');
    }
  }

  function isEditorLike(el) {
    return !!el && (el.id === 'waffle-rich-text-editor' || (el.classList && el.classList.contains('cell-input')) ||
      (el.closest && el.closest('#t-formula-bar-input')));
  }

  // 公式栏当前显示的文本（选中单元格但未编辑时，它也会显示该单元格内容）
  function getFormulaBarText() {
    const fb = document.querySelector('#t-formula-bar-input .cell-input') || document.querySelector('#t-formula-bar-input');
    return getExactTextFromEditor(fb);
  }

  function getActiveCellInfo() {
    const nameBox = document.querySelector('#t-name-box') || document.querySelector('.waffle-name-box');
    if (!nameBox || !nameBox.value) return null;
    const match = nameBox.value.match(/^([A-Z]+)(\d+)$/i);
    if (!match) return null;

    const colIdx = colLetterToIndex(match[1].toUpperCase());
    const rowNum = parseInt(match[2], 10);

    // liveText：正在编辑的输入框内容（仅当焦点确实在编辑器里）。未编辑时它是空的，不能当成单元格内容！
    const ae = document.activeElement;
    const liveText = isEditorLike(ae) ? getExactTextFromEditor(ae.closest('.cell-input') || ae) : '';
    return { colIdx, rowNum, liveText, fbText: getFormulaBarText() };
  }

  let localDiffTimer = null;
  let localSettleTimer = null;

  function applyLocalCell(text, cellInfo) {
    const col1Idx = colLetterToIndex(lastCompareParams.col1);
    const col2Idx = colLetterToIndex(lastCompareParams.col2);
    if (cellInfo.colIdx !== col1Idx && cellInfo.colIdx !== col2Idx) return;
    const rowIdx = cellInfo.rowNum - 1;
    while (localTableData.length <= rowIdx) localTableData.push([]);
    if (localTableData[rowIdx][cellInfo.colIdx] === text) return;
    localTableData[rowIdx][cellInfo.colIdx] = text;
    executeDiffAndRender(localTableData);
  }

  function triggerLocalDiffUpdate() {
    if (!lastCompareParams || !localTableData || localTableData.length === 0) return;
    if (localDiffTimer) clearTimeout(localDiffTimer);
    if (localSettleTimer) clearTimeout(localSettleTimer);

    // 第一遍（快）：只在“确实有编辑器内容”时写入，保证打字即时刷新。
    // 绝不在这里写空串——方向键/回车/粘贴后焦点编辑器是空的，且公式栏尚未更新，写入会把单元格误判为空。
    localDiffTimer = setTimeout(() => {
      const info = getActiveCellInfo();
      if (!info || !info.liveText) return;
      applyLocalCell(info.liveText, info);
    }, 50);

    // 第二遍（稳）：等 Sheets 把公式栏刷新完，以公式栏内容为准校正（覆盖 切换单元格/回车提交/粘贴/清空 等场景）
    localSettleTimer = setTimeout(() => {
      const info = getActiveCellInfo();
      if (!info) return;
      applyLocalCell(info.liveText || info.fbText, info);
    }, 350);
  }

  window.addEventListener('keyup', (e) => {
    if (e.target.closest('#t-formula-bar-input') || e.target.closest('.cell-input') || e.target.id === 'waffle-rich-text-editor') {
      triggerLocalDiffUpdate();
    }
  }, { capture: true });

  window.addEventListener('paste', () => { triggerLocalDiffUpdate(); }, { capture: true });
  window.addEventListener('cut', () => { triggerLocalDiffUpdate(); }, { capture: true });

  window.addEventListener('input', (e) => {
    if (e.target.closest('#t-formula-bar-input') || e.target.closest('.cell-input') || e.target.id === 'waffle-rich-text-editor') {
      triggerLocalDiffUpdate();
    }
  }, { capture: true });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'COMPARE') {
      hidePanelOnEdit = request.hideOnEdit;
      runComparison(request.col1, request.col2, request.granularity, request.colorDel, request.colorAdd)
        .then(msg => sendResponse({ status: msg, error: false }))
        .catch(err => sendResponse({ status: '错误: ' + err.message, error: true }));
      return true;
    }
    
    if (request.action === 'CLEAR') {
      window.dispatchEvent(new CustomEvent('GS_STOP_TRACKING')); 
      currentComparingGid = null;
      lastCompareParams = null;
      localTableData = [];
      const sidePanel = document.getElementById('gs-side-panel');
      if (sidePanel) sidePanel.innerHTML = '';
      sendResponse({ status: '已清除页面卡片', error: false });
    }
    
    if (request.action === 'UPDATE_SETTINGS') {
      hidePanelOnEdit = request.hideOnEdit;
      applyColors(request.colorDel, request.colorAdd);
      sendResponse({ status: '设置已更新', error: false });
    }
  });

  function getStableRowStyle(rowH, currentWidth) {
    const wFactor = Math.max(0.85, Math.min(1.25, currentWidth / 580));
    if (rowH >= 110) {
      const fs = Math.min(16.5, Math.max(14, 15 * wFactor)).toFixed(1);
      return {
        fs: `${fs}px`, padY: `${Math.round(8 * wFactor)}px`, padX: '14px',
        lineH: (1.42 + 0.05 * wFactor).toFixed(2), headerFs: `${Math.min(13, Math.max(11, 12 * wFactor)).toFixed(1)}px`, headerPadY: '4px'
      };
    } else if (rowH >= 65) {
      const fs = Math.min(15, Math.max(13, 13.5 * wFactor)).toFixed(1);
      return {
        fs: `${fs}px`, padY: `${Math.round(6 * wFactor)}px`, padX: '12px',
        lineH: '1.38', headerFs: '11px', headerPadY: '3px'
      };
    } else {
      const fs = Math.min(14, Math.max(12, 12.5 * wFactor)).toFixed(1);
      return {
        fs: `${fs}px`, padY: '5px', padX: '11px',
        lineH: '1.32', headerFs: '10.5px', headerPadY: '2px'
      };
    }
  }

  function adjustCardLayout(visibleEntries) {
    if (!visibleEntries.length) return;
    const minSafeTop = 130;
    const maxSafeBottom = window.innerHeight - 65;

    for (const item of visibleEntries) {
      const style = getStableRowStyle(item.rowH, currentPanelWidth);
      const card = item.card;
      card.style.setProperty('--card-fs', style.fs);
      card.style.setProperty('--card-pad-y', style.padY);
      card.style.setProperty('--card-pad-x', style.padX);
      card.style.setProperty('--card-line-height', style.lineH);
      card.style.setProperty('--card-header-fs', style.headerFs);
      card.style.setProperty('--card-header-pad-y', style.headerPadY);
      card.style.removeProperty('max-height');
      card.style.display = 'flex';
      card.style.top = `${item.y}px`;
      card.classList.remove('gs-dock-bottom');
      item.targetY = item.y;
    }

    for (const item of visibleEntries) item.height = item.card.offsetHeight || 50;

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < visibleEntries.length - 1; i++) {
        const curr = visibleEntries[i];
        const next = visibleEntries[i + 1];
        const overlap = (curr.targetY + curr.height / 2) - (next.targetY - next.height / 2) + 4;
        if (overlap > 0) {
          const shift = Math.min(16, overlap / 2);
          curr.targetY -= shift; next.targetY += shift;
        }
      }
    }

    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const item = visibleEntries[i];
      if (item.targetY + item.height / 2 > maxSafeBottom) {
        const pushUp = (item.targetY + item.height / 2) - maxSafeBottom;
        item.targetY -= pushUp;
        item.card.classList.add('gs-dock-bottom');
        if (i > 0) {
          const prev = visibleEntries[i - 1];
          if (prev.targetY + prev.height / 2 > item.targetY - item.height / 2) {
            prev.targetY = item.targetY - item.height / 2 - prev.height / 2 - 2;
          }
        }
      }
    }

    for (let i = 0; i < visibleEntries.length; i++) {
      const item = visibleEntries[i];
      if (item.targetY - item.height / 2 < minSafeTop) item.targetY = minSafeTop + item.height / 2;
      item.card.style.top = `${item.targetY}px`;
    }
  }

  // ================= 核心升级：动态矩阵缩放隔离算法，彻底消灭幽灵卡片！ =================
  let rowHeadersThisFrame = [];
  let drawTimer = null;
  let canvasTopOffset = 0;

  const origFillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    origFillText.apply(this, arguments);

    if (!currentComparingGid || !this.canvas) return;

    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return;

    // 获取画布的真实转换矩阵
    const m = this.getTransform();
    // 根据矩阵换算出屏幕上的物理绝对像素坐标
    const absX = x * m.a + y * m.c + m.e;
    const absY = x * m.b + y * m.d + m.f;
    const scale = m.a || 1;

    // 核心物理隔离墙：原生灰色行号列的固定物理宽度是 46px。
    // 计算缩放后的边界，只要 X 坐标超出了 46*scale，它就绝对是用户写在 A 列里的数据，直接拦截！
    const rowHeaderBoundary = 46 * scale;

    // 严苛过滤：只认处于 0 ~ rowHeaderBoundary 之间、且纯由数字组成的文本
    if (absX > 0 && absX <= rowHeaderBoundary - 2 && /^\d+$/.test(t)) {
      if (!drawTimer) {
        canvasTopOffset = this.canvas.getBoundingClientRect().top;
        drawTimer = setTimeout(() => {
          const yMap = {};
          const yGroups = {};
          
          for (const item of rowHeadersThisFrame) {
            const key = Math.round(item.y / 4);
            if (!yGroups[key]) yGroups[key] = [];
            yGroups[key].push(item);
          }
          
          for (const key in yGroups) {
            const leftMost = yGroups[key].reduce((prev, curr) => prev.x < curr.x ? prev : curr);
            yMap[leftMost.text] = canvasTopOffset + leftMost.y;
          }

          window.dispatchEvent(new CustomEvent('GS_Y_MAP', { detail: { yMap } }));
          rowHeadersThisFrame = [];
          drawTimer = null;
        }, 30);
      }
      rowHeadersThisFrame.push({ text: t, x: absX, y: absY });
    } else if (absX > rowHeaderBoundary && t.length > 0) {
      if (this.font) {
        const match = this.font.match(/(\d+(?:\.\d+)?)px/);
        if (match) {
          const fs = parseFloat(match[1]);
          if (fs > 8 && fs < 100) window.dispatchEvent(new CustomEvent('GS_FONT_SIZE', { detail: fs }));
        }
      }
    }
  };

  window.addEventListener('GS_Y_MAP', (e) => {
    const yMap = e.detail.yMap;
    const sidePanel = document.getElementById('gs-side-panel');
    if (!sidePanel || sidePanel.classList.contains('gs-tab-hidden')) return;

    const allCards = sidePanel.querySelectorAll('.gs-diff-card');
    allCards.forEach(c => c.style.display = 'none');

    const allDrawnNums = Object.keys(yMap).map(n => parseInt(n, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (let idx = 0; idx < allDrawnNums.length - 1; idx++) {
      const r1 = allDrawnNums[idx], r2 = allDrawnNums[idx + 1], dist = yMap[r2] - yMap[r1];
      if (dist > 18 && dist < 1500) rowHeightCache[r1] = dist;
    }

    const viewportTop = 135, viewportBottom = window.innerHeight - 55, viewportHeight = viewportBottom - viewportTop;
    const visibleEntries = [];

    for (let rowNumStr in yMap) {
      const rowNum = parseInt(rowNumStr, 10);
      const card = document.getElementById(`gs-card-${rowNum}`);
      if (!card) continue;
      const rowY = yMap[rowNumStr];
      let rowH = rowHeightCache[rowNum];
      if (!rowH) {
        const idx = allDrawnNums.indexOf(rowNum);
        if (idx !== -1 && idx < allDrawnNums.length - 1) rowH = yMap[allDrawnNums[idx + 1]] - rowY;
      }
      rowH = rowH || 65;

      const cellTop = rowY - rowH / 2, cellBottom = rowY + rowH / 2;
      const visibleTop = Math.max(cellTop, viewportTop), visibleBottom = Math.min(cellBottom, viewportBottom);
      const visibleH = Math.max(0, visibleBottom - visibleTop);
      const isUltraTall = rowH > viewportHeight * 0.6;

      let isVisibleEnough = false;
      if (isUltraTall) {
        isVisibleEnough = visibleH >= 80 || (cellTop <= viewportTop && cellBottom >= viewportBottom);
      } else {
        isVisibleEnough = (visibleH / rowH) >= 0.70;
      }

      // ================= 绝对可视豁免 =================
      if (rowY >= viewportTop + 15 && rowY <= viewportBottom - 15) {
        isVisibleEnough = true;
      }

      if (isVisibleEnough) visibleEntries.push({ rowNum, card, y: rowY, rowH: rowH });
    }

    visibleEntries.sort((a, b) => a.y - b.y);
    latestVisibleEntries = visibleEntries;
    adjustCardLayout(visibleEntries);
  });

  window.addEventListener('GS_FONT_SIZE', (e) => {
    currentDetectedFontSize = Math.max(12.5, Math.min(16, e.detail || 13));
    const panel = document.getElementById('gs-side-panel');
    if (panel) panel.style.setProperty('--gs-card-font-size', currentDetectedFontSize + 'px');
  });

  function handleWheelOnly(e) {
    if (!e || (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1)) return;
    const sidePanel = document.getElementById('gs-side-panel');
    if (sidePanel) sidePanel.classList.remove('gs-panel-hidden');
    isSuppressedByScroll = true;
  }

  window.addEventListener('wheel', handleWheelOnly, { passive: true });

  function cancelScrollExemption() { isSuppressedByScroll = false; }
  window.addEventListener('dblclick', (e) => { if (!e.target.closest('#gs-side-panel')) cancelScrollExemption(); }, { capture: true });
  window.addEventListener('keydown', (e) => {
    if (!e.target.closest('#gs-side-panel') && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) cancelScrollExemption();
  }, { capture: true });

  document.addEventListener('mouseover', (e) => {
    if (e.target && e.target.closest && e.target.closest('#docs-toolbar, #docs-menubar, #formula-bar, .docs-toolbar, .docs-menubar')) isHoveringToolbar = true;
  }, { capture: true, passive: true });
  document.addEventListener('mouseout', (e) => {
    if (e.target && e.target.closest && e.target.closest('#docs-toolbar, #docs-menubar, #formula-bar, .docs-toolbar, .docs-menubar')) {
      if (!e.relatedTarget || !e.relatedTarget.closest('#docs-toolbar, #docs-menubar, #formula-bar, .docs-toolbar, .docs-menubar')) isHoveringToolbar = false;
    }
  }, { capture: true, passive: true });

  function isRealEditingActive() {
    const active = document.activeElement;
    if (active && (active.id === 't-formula-bar-input' || (active.closest && active.closest('.formula-input-container')))) return true;
    const cancelBtn = document.querySelector('.formula-bar-cancel-button, #formula-bar-cancel-button, [data-tooltip*="Cancel"], [aria-label*="Cancel"]');
    if (cancelBtn && cancelBtn.offsetWidth > 5 && window.getComputedStyle(cancelBtn).display !== 'none') return true;
    
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) {
      if (!active.closest('#gs-side-panel') && !active.closest('#gs-top-navbar')) {
        const rect = active.getBoundingClientRect();
        if (rect.width > 15 && rect.height > 10 && rect.top > -50 && rect.left > -50 && window.getComputedStyle(active).opacity !== '0') return true;
      }
    }
    const editor = document.getElementById('waffle-rich-text-editor');
    if (editor) {
      if (document.activeElement === editor || editor.contains(document.activeElement)) return true;
      const rect = editor.getBoundingClientRect();
      if (rect.width > 15 && rect.height > 10 && rect.top > -50 && rect.left > -50 && window.getComputedStyle(editor).opacity !== '0') return true;
    }
    return false;
  }

  function isSheetsPopupOpen() {
    const popups = document.querySelectorAll('.goog-menu, .goog-palette, .docs-material-menu, .docs-material-color-palette, .docs-bubble, .modal-dialog, .picker-dialog, .waffle-filter-view-popup, .apps-palette');
    for (let i = 0; i < popups.length; i++) {
      if (popups[i].closest('#gs-side-panel')) continue;
      if (popups[i].offsetWidth > 5 && popups[i].offsetHeight > 5 && window.getComputedStyle(popups[i]).opacity !== '0') return true;
    }
    return false;
  }

  function setPanelHidden(hidden) {
    const sidePanel = document.getElementById('gs-side-panel');
    if (!sidePanel) return;

    if (hidden) {
      sidePanel.classList.add('gs-panel-hidden');
    } else {
      sidePanel.classList.remove('gs-panel-hidden');
    }
  }

  function startEditingDetector() {
    if (editCheckTimer) clearInterval(editCheckTimer);
    editCheckTimer = setInterval(() => {
      const sidePanel = document.getElementById('gs-side-panel');
      if (!sidePanel) return;

      if (currentComparingGid !== null) {
        const activeGid = getCurrentActiveGid();
        if (activeGid !== currentComparingGid) {
          sidePanel.classList.add('gs-tab-hidden');
          return;
        } else {
          sidePanel.classList.remove('gs-tab-hidden');
        }
      }

      if (!hidePanelOnEdit) { setPanelHidden(false); return; }
      if (isSheetsPopupOpen() || isHoveringToolbar) { setPanelHidden(true); return; }
      if (isHoveringPanel) { setPanelHidden(false); return; }

      const editing = isRealEditingActive();
      
      if (!editing) {
        setPanelHidden(false);
        return;
      }

      if (isSuppressedByScroll) setPanelHidden(false);
      else setPanelHidden(true);
      
    }, 150);
  }

  window.addEventListener('load', () => {
    chrome.storage.local.get(['gs_hideOnEdit', 'gs_color_del', 'gs_color_add'], (res) => {
      if (res) {
        hidePanelOnEdit = res.gs_hideOnEdit !== false;
        applyColors(res.gs_color_del || '#d93025', res.gs_color_add || '#137333');
      }
    });
    startEditingDetector();
  });
})();
