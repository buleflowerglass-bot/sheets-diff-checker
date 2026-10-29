document.addEventListener('DOMContentLoaded', () => {
  const col1 = document.getElementById('col1');
  const col2 = document.getElementById('col2');
  const granularity = document.getElementById('granularity');
  const hideOnEdit = document.getElementById('hideOnEdit');
  const autoRecompare = document.getElementById('autoRecompare');
  const colorDel = document.getElementById('colorDel');
  const colorAdd = document.getElementById('colorAdd');
  const btnCompare = document.getElementById('btnCompare');
  const btnClear = document.getElementById('btnClear');
  const statusEl = document.getElementById('status');

  chrome.storage.local.get(['gs_col1', 'gs_col2', 'gs_granularity', 'gs_hideOnEdit', 'gs_auto_recompare', 'gs_color_del', 'gs_color_add'], (res) => {
    col1.value = res.gs_col1 || 'C';
    col2.value = res.gs_col2 || 'G';
    granularity.value = res.gs_granularity || 'word';
    hideOnEdit.checked = res.gs_hideOnEdit !== false;
    autoRecompare.checked = res.gs_auto_recompare !== false;
    colorDel.value = res.gs_color_del || '#d93025';
    colorAdd.value = res.gs_color_add || '#137333';
  });

  function showStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.style.display = 'block';
    statusEl.style.color = isError ? '#d93025' : '#137333';
    statusEl.style.backgroundColor = isError ? '#fce8e6' : '#e6f4ea';
  }

  function sendToContent(action, data = {}) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].url.includes('docs.google.com/spreadsheets')) {
        showStatus('请在谷歌表格页面内使用！', true);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          showStatus('请刷新表格页面后再试一次。', true);
        } else if (response) {
          showStatus(response.status, response.error);
        }
      });
    });
  }

  btnCompare.addEventListener('click', () => {
    const c1 = col1.value.trim().toUpperCase();
    const c2 = col2.value.trim().toUpperCase();
    const gran = granularity.value;
    const hide = hideOnEdit.checked;
    const autoRec = autoRecompare.checked;
    const cDel = colorDel.value;
    const cAdd = colorAdd.value;

    if (!c1 || !c2) {
      showStatus('请输入列字母！', true);
      return;
    }
    
    chrome.storage.local.set({
      gs_col1: c1, gs_col2: c2, gs_granularity: gran, gs_hideOnEdit: hide, gs_auto_recompare: autoRec, gs_color_del: cDel, gs_color_add: cAdd
    });
    
    showStatus('正在提取数据，请稍候...', false);
    sendToContent('COMPARE', {
      col1: c1, col2: c2, granularity: gran, hideOnEdit: hide, autoRecompare: autoRec, colorDel: cDel, colorAdd: cAdd
    });
  });

  btnClear.addEventListener('click', () => {
    sendToContent('CLEAR');
  });

  function notifySettingsChange() {
    chrome.storage.local.set({
      gs_hideOnEdit: hideOnEdit.checked,
      gs_auto_recompare: autoRecompare.checked,
      gs_color_del: colorDel.value,
      gs_color_add: colorAdd.value
    });
    sendToContent('UPDATE_SETTINGS', {
      hideOnEdit: hideOnEdit.checked,
      autoRecompare: autoRecompare.checked,
      colorDel: colorDel.value,
      colorAdd: colorAdd.value
    });
  }

  colorDel.addEventListener('input', notifySettingsChange);
  colorAdd.addEventListener('input', notifySettingsChange);
  hideOnEdit.addEventListener('change', notifySettingsChange);
  autoRecompare.addEventListener('change', notifySettingsChange);
});