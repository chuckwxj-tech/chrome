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
  const recentSection = document.getElementById('recentSection');
  const recentList = document.getElementById('recentList');
  const tagsContainer = document.getElementById('tagsContainer');
  const queueBanner = document.getElementById('queueBanner');

  const DEFAULT_TAGS = [
    'AI服务器', 'CPO', '光模块', 'PCB', 'MLCC', 'HBM', '半导体设备',
    '算力', '先进封装', '美股', 'A股映射', '港股', '财报', '行业趋势', '政策',
  ];

  // ── State ──────────────────────────────────────────────────────
  let selectedTags = [];
  let priority = 'high';

  // ── Load saved state ───────────────────────────────────────────
  const items = await chrome.storage.local.get([
    'tags', 'priority', 'research_intent', 'user_notes', 'custom_tags'
  ]);
  if (items.tags) selectedTags = items.tags;
  if (items.priority) priority = items.priority;
  if (items.research_intent) researchIntent.value = items.research_intent;
  if (items.user_notes) userNotes.value = items.user_notes;
  const availableTags = (Array.isArray(items.custom_tags) && items.custom_tags.length)
    ? items.custom_tags
    : DEFAULT_TAGS;

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

  // ── Tag chips (rendered from options-configurable list) ───────
  for (const tag of availableTags) {
    const chip = document.createElement('button');
    chip.className = 'tag-chip';
    chip.dataset.tag = tag;
    chip.textContent = tag;
    if (selectedTags.includes(tag)) chip.classList.add('active');

    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        if (!selectedTags.includes(tag)) selectedTags.push(tag);
      } else {
        selectedTags = selectedTags.filter(t => t !== tag);
      }
      savePrefs();
    });
    tagsContainer.appendChild(chip);
  }
  // Drop selections for tags no longer offered
  selectedTags = selectedTags.filter(t => availableTags.includes(t));

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
    if (!recentSection.hidden) {
      recentSection.hidden = true;
      return;
    }
    showStatus('loading', '加载最近捕获...');
    chrome.runtime.sendMessage({ type: 'GET_RECENT', limit: 10 }, (result) => {
      if (!result?.success) {
        showStatus('error', result?.error || '无法获取最近捕获');
        return;
      }
      renderRecent(result.captures);
      recentSection.hidden = false;
      showStatus('success', `共 ${result.total} 条捕获`);
    });
  });

  const TYPE_LABELS = {
    page: '页面',
    selection: '选文',
    link: '链接',
    pdf: 'PDF',
    image: '图片',
  };

  function renderRecent(captures) {
    recentList.textContent = '';
    if (!captures.length) {
      const empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = '暂无捕获记录';
      recentList.appendChild(empty);
      return;
    }
    for (const item of captures) {
      const row = document.createElement('a');
      row.className = 'recent-item';
      row.href = item.url;
      row.target = '_blank';
      row.rel = 'noopener';
      row.title = item.url;

      const type = document.createElement('span');
      type.className = 'recent-type';
      type.textContent = TYPE_LABELS[item.capture_type] || item.capture_type;

      const main = document.createElement('span');
      main.className = 'recent-main';
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = item.title || item.url;
      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = `${item.source_domain} · ${formatRelativeTime(item.captured_at)}`;
      main.appendChild(title);
      main.appendChild(meta);

      row.appendChild(type);
      row.appendChild(main);
      recentList.appendChild(row);
    }
  }

  function formatRelativeTime(isoString) {
    const then = Date.parse(isoString);
    if (Number.isNaN(then)) return '';
    const diffMin = Math.floor((Date.now() - then) / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    return `${Math.floor(diffHours / 24)} 天前`;
  }

  // ── Offline retry queue banner ─────────────────────────────────
  function refreshQueueBanner() {
    chrome.runtime.sendMessage({ type: 'QUEUE_STATUS' }, (result) => {
      const count = result?.count || 0;
      queueBanner.hidden = count === 0;
      if (count > 0) {
        queueBanner.textContent = `⚠ ${count} 条采集待补传 — 点击立即重试`;
      }
    });
  }

  queueBanner.addEventListener('click', () => {
    queueBanner.disabled = true;
    queueBanner.textContent = '补传中...';
    chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' }, (result) => {
      queueBanner.disabled = false;
      if (result?.flushed > 0) {
        showStatus('success', `已补传 ${result.flushed} 条`);
      } else if (result?.remaining > 0) {
        showStatus('error', '补传失败，服务器仍不可达');
      }
      refreshQueueBanner();
    });
  });

  refreshQueueBanner();

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
