// background.js - 负责绕过页面端 CORS 限制拉取表格 CSV
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'FETCH_SHEET_CSV') {
    // Content scripts are less trusted than the service worker. Only allow a
    // top-level Sheets page to fetch its own CSV export, never an arbitrary URL.
    const senderUrl = sender.url ? new URL(sender.url) : null;
    const senderSheetMatch = senderUrl?.origin === 'https://docs.google.com'
      ? senderUrl.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/edit\/?$/)
      : null;
    let exportUrl;
    try {
      exportUrl = new URL(request.url);
    } catch {
      sendResponse({ success: false, error: '无效的导出地址' });
      return false;
    }

    const exportMatch = exportUrl.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/export$/);
    const gid = exportUrl.searchParams.get('gid');
    const queryKeys = Array.from(exportUrl.searchParams.keys());
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !senderSheetMatch ||
        exportUrl.origin !== 'https://docs.google.com' || !exportMatch ||
        exportMatch[1] !== senderSheetMatch[1] ||
        exportUrl.searchParams.getAll('format').length !== 1 ||
        exportUrl.searchParams.get('format') !== 'csv' ||
        exportUrl.searchParams.getAll('gid').length !== 1 || !gid || !/^\d+$/.test(gid) ||
        queryKeys.some((key) => !['format', 'gid', '_t'].includes(key))) {
      sendResponse({ success: false, error: '拒绝非当前表格的导出请求' });
      return false;
    }

    // 核心：cache: 'no-store' 杜绝任何 HTTP 强缓存，确保每次都是最新的表格内容
    fetch(exportUrl.href, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const finalUrl = new URL(response.url);
        const finalHostAllowed = finalUrl.protocol === 'https:' &&
          (finalUrl.hostname === 'docs.google.com' ||
            finalUrl.hostname === 'googleusercontent.com' ||
            finalUrl.hostname.endsWith('.googleusercontent.com'));
        if (!finalHostAllowed) {
          throw new Error('导出请求跳转到了未允许的主机');
        }
        if (!response.ok) {
          throw new Error(`HTTP 状态码: ${response.status} (${response.statusText})`);
        }
        const text = await response.text();
        sendResponse({ success: true, data: text });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });

    return true; // 保持异步通道开启
  }
});
