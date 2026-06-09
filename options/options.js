// Cloud Vault Capture — Options Logic

document.addEventListener('DOMContentLoaded', async () => {
  const apiUrl = document.getElementById('apiUrl');
  const captureToken = document.getElementById('captureToken');
  const btnSave = document.getElementById('btnSave');
  const btnTest = document.getElementById('btnTest');
  const statusArea = document.getElementById('statusArea');

  // Load saved values
  const items = await chrome.storage.local.get(['api_base_url', 'capture_token']);
  if (items.api_base_url) apiUrl.value = items.api_base_url;
  if (items.capture_token) captureToken.value = items.capture_token;

  function showStatus(msg, type) {
    statusArea.innerHTML = `<div class="status ${type}">${msg}</div>`;
  }

  btnSave.addEventListener('click', async () => {
    const url = apiUrl.value.trim().replace(/\/+$/, '');
    const token = captureToken.value.trim();

    if (!url) {
      showStatus('请输入 API 服务器地址', 'error');
      return;
    }

    await chrome.storage.local.set({
      api_base_url: url,
      capture_token: token,
    });

    showStatus('设置已保存', 'success');
  });

  btnTest.addEventListener('click', async () => {
    const url = apiUrl.value.trim().replace(/\/+$/, '');
    const token = captureToken.value.trim();

    if (!url) {
      showStatus('请先输入 API 服务器地址', 'error');
      return;
    }

    showStatus('正在连接...', 'info');

    try {
      const resp = await fetch(`${url}/health`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (resp.ok) {
        const data = await resp.json();
        showStatus(`连接成功! 服务器版本: ${data.version || 'unknown'}`, 'success');
      } else if (resp.status === 401 || resp.status === 403) {
        showStatus('Token 无效，请检查后重试', 'error');
      } else {
        showStatus(`服务器返回错误: ${resp.status}`, 'error');
      }
    } catch (err) {
      showStatus(`无法连接: ${err.message}`, 'error');
    }
  });
});
