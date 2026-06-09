document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const btnSavePage = $('btnSavePage');
  const btnSaveSelection = $('btnSaveSelection');
  const btnSaveLink = $('btnSaveLink');
  const researchIntent = $('researchIntent');
  const userNotes = $('userNotes');
  const statusBar = $('statusBar');
  const statusText = $('statusText');
  const statusDot = $('statusDot');
  const linkOptions = $('linkOptions');
  const linkRecent = $('linkRecent');

  let selectedTags = [];
  let priority = 'high';

  const items = await chrome.storage.local.get([
    'tags',
    'priority',
    'research_intent',
    'user_notes',
  ]);
  if (items.tags) selectedTags = items.tags;
  if (items.priority) priority = items.priority;
  if (items.research_intent) researchIntent.value = items.research_intent;
  if (items.user_notes) userNotes.value = items.user_notes;

  document.querySelectorAll('.priority-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.priority === priority);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.priority-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      priority = btn.dataset.priority;
      savePrefs();
    });
  });

  document.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.classList.toggle('active', selectedTags.includes(chip.dataset.tag));
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        if (!selectedTags.includes(chip.dataset.tag)) selectedTags.push(chip.dataset.tag);
      } else {
        selectedTags = selectedTags.filter((tag) => tag !== chip.dataset.tag);
      }
      savePrefs();
    });
  });

  researchIntent.addEventListener('change', savePrefs);
  userNotes.addEventListener('change', savePrefs);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      } catch (_) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/readability.js', 'content.js'],
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const selection = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
      if (selection?.text) {
        btnSaveSelection.disabled = false;
        btnSaveSelection.title = `选中文本: ${selection.text.slice(0, 60)}...`;
      }
    } catch (_) {
      // Some Chrome pages and extension pages cannot receive content scripts.
    }
  }

  btnSavePage.addEventListener('click', () => capture({ type: 'CAPTURE_PAGE' }, '提取中...'));
  btnSaveSelection.addEventListener('click', () => {
    if (!btnSaveSelection.disabled) capture({ type: 'CAPTURE_SELECTION' }, '保存中...');
  });
  btnSaveLink.addEventListener('click', async () => {
    const url = prompt('输入要保存的链接：', 'https://');
    if (!url) return;
    await capture({
      type: /\.pdf(\?|$)/i.test(url) ? 'CAPTURE_PDF' : 'CAPTURE_LINK',
      url,
      linkText: url,
    }, '保存中...');
  });

  linkOptions.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  linkRecent.addEventListener('click', (event) => {
    event.preventDefault();
    checkConnection(true);
  });

  const config = await chrome.storage.local.get(['api_base_url', 'capture_token']);
  if (!config.api_base_url || !config.capture_token) {
    statusDot.className = 'status-dot error';
    statusDot.title = '未配置，请点击下方设置';
    showStatus('error', '请先配置 API 地址和 Token（点击下方"设置"）');
  } else {
    checkConnection(false);
  }

  function savePrefs() {
    chrome.storage.local.set({
      tags: selectedTags,
      priority,
      research_intent: researchIntent.value,
      user_notes: userNotes.value,
    });
  }

  async function capture(message, loadingText) {
    showStatus('loading', loadingText);
    try {
      handleResult(await chrome.runtime.sendMessage(message));
    } catch (error) {
      showStatus('error', `错误: ${error.message}`);
    }
  }

  function handleResult(result) {
    if (!result) {
      showStatus('error', '无响应');
      return;
    }
    if (result.dedup_status === 'duplicate') {
      showStatus('dup', '已存在 (重复)');
    } else if (result.success) {
      showStatus('success', result.dedup_status === 'fuzzy_warn' ? '已保存 (可能重复)' : '已保存');
    } else {
      const detail = result.error || '未知错误';
      showStatus('error', detail.length > 40 ? `${detail.slice(0, 40)}...` : detail);
    }
  }

  function showStatus(type, message) {
    statusBar.className = `status-bar ${type}`;
    statusText.textContent = message;
  }

  function checkConnection(showText) {
    chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (result) => {
      if (result?.success) {
        statusDot.className = 'status-dot ok';
        statusDot.title = '服务器已连接';
        if (showText) showStatus('success', '服务器已连接');
      } else {
        statusDot.className = 'status-dot error';
        statusDot.title = '无法连接，请检查配置';
        if (showText) showStatus('error', '无法连接服务器');
      }
    });
  }
});
