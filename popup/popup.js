// Cloud Vault Capture — Popup Logic

document.addEventListener('DOMContentLoaded', async () => {
  // ── DOM refs ──────────────────────────────────────────────────
  const btnSavePage = document.getElementById('btnSavePage');
  const btnSaveSelection = document.getElementById('btnSaveSelection');
  const btnSaveLink = document.getElementById('btnSaveLink');
  const researchIntent = document.getElementById('researchIntent');
  const userNotes = document.getElementById('userNotes');
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  const linkOptions = document.getElementById('linkOptions');
  const linkRecent = document.getElementById('linkRecent');

  // ── State ──────────────────────────────────────────────────────
  let selectedTags = [];
  let priority = 'high';

  // ── Load saved state ───────────────────────────────────────────
  const items = await chrome.storage.local.get([
    'tags', 'priority', 'research_intent', 'user_notes'
  ]);
  if (items.tags) selectedTags = items.tags;
  if (items.priority) priority = items.priority;
  if (items.research_intent) researchIntent.value = items.research_intent;
  if (items.user_notes) userNotes.value = items.user_notes;

  // ── Init UI state ──────────────────────────────────────────────
  // Check if there's a text selection
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      // Try ping first, inject content script if needed
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      } catch (_) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/readability.js', 'content.js'],
        });
        await new Promise(r => setTimeout(r, 150));
      }
      const selResult = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
      if (selResult?.text) {
        btnSaveSelection.disabled = false;
        btnSaveSelection.title = `选中文本: ${selResult.text.slice(0, 60)}...`;
      }
    } catch (e) {
      // Content script may not be available on this page
    }
  }

  // ── Priority buttons ──────────────────────────────────────────
  document.querySelectorAll('.priority-btn').forEach(btn => {
    if (btn.dataset.priority === priority) btn.classList.add('active');
    else btn.classList.remove('active');

    btn.addEventListener('click', () => {
      document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      priority = btn.dataset.priority;
      savePrefs();
    });
  });

  // ── Tag chips ──────────────────────────────────────────────────
  document.querySelectorAll('.tag-chip').forEach(chip => {
    if (selectedTags.includes(chip.dataset.tag)) chip.classList.add('active');

    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        if (!selectedTags.includes(chip.dataset.tag)) selectedTags.push(chip.dataset.tag);
      } else {
        selectedTags = selectedTags.filter(t => t !== chip.dataset.tag);
      }
      savePrefs();
    });
  });

  // ── Input changes → save ──────────────────────────────────────
  researchIntent.addEventListener('change', savePrefs);
  userNotes.addEventListener('change', savePrefs);

  function savePrefs() {
    chrome.storage.local.set({
      tags: selectedTags,
      priority,
      research_intent: researchIntent.value,
      user_notes: userNotes.value,
    });
  }

  // ── Button handlers ────────────────────────────────────────────
  btnSavePage.addEventListener('click', async () => {
    showStatus('loading', '提取中...');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE' });
      handleResult(result);
    } catch (err) {
      showStatus('error', `错误: ${err.message}`);
    }
  });

  btnSaveSelection.addEventListener('click', async () => {
    if (btnSaveSelection.disabled) return;
    showStatus('loading', '保存中...');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_SELECTION' });
      handleResult(result);
    } catch (err) {
      showStatus('error', `错误: ${err.message}`);
    }
  });

  btnSaveLink.addEventListener('click', async () => {
    const url = prompt('输入要保存的链接：', 'https://');
    if (!url) return;
    showStatus('loading', '保存中...');
    const isPdf = /\.pdf(\?|$)/i.test(url);
    try {
      const result = await chrome.runtime.sendMessage({
        type: isPdf ? 'CAPTURE_PDF' : 'CAPTURE_LINK',
        url,
        linkText: url,
      });
      handleResult(result);
    } catch (err) {
      showStatus('error', `错误: ${err.message}`);
    }
  });

  // ── Result display ─────────────────────────────────────────────
  function handleResult(result) {
    if (!result) {
      showStatus('error', '无响应');
      return;
    }

    if (result.dedup_status === 'duplicate') {
      showStatus('dup', '已存在 (重复)');
    } else if (result.success) {
      const msg = result.dedup_status === 'fuzzy_warn'
        ? '已保存 (可能重复)'
        : '已保存';
      showStatus('success', msg);
    } else {
      const detail = result.error || '未知错误';
      showStatus('error', detail.length > 40 ? detail.slice(0, 40) + '...' : detail);
    }
  }

  function showStatus(type, msg) {
    statusBar.className = `status-bar ${type}`;
    statusText.textContent = msg;
  }

  // ── Footer links ───────────────────────────────────────────────
  linkOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  linkRecent.addEventListener('click', (e) => {
    e.preventDefault();
    // For now, just show captured count from a quick API call
    chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (result) => {
      if (result?.success) {
        showStatus('success', '服务器已连接');
      } else {
        showStatus('error', '无法连接服务器');
      }
    });
  });

  // ── Connection & config check on open ──────────────────────────
  const config = await chrome.storage.local.get(['api_base_url', 'capture_token']);
  if (!config.capture_token || !config.api_base_url) {
    statusDot.className = 'status-dot error';
    statusDot.title = '未配置 — 请点击下方"设置"';
    showStatus(
      'error',
      '请先配置 API 地址和 Token（点击下方"设置"）',
    );
  } else {
    chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (result) => {
      if (result?.success) {
        statusDot.className = 'status-dot ok';
        statusDot.title = '服务器已连接';
      } else {
        statusDot.className = 'status-dot error';
        statusDot.title = '无法连接 — ' + (result?.error || '请检查配置');
      }
    });
  }
});
