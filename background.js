// Cloud Vault Capture — Service Worker
// API client, context menus, keyboard shortcuts, message relay

const DEFAULT_API_BASE = 'http://localhost:8000';

// ── Config ───────────────────────────────────────────────────────
async function getConfig() {
  const items = await chrome.storage.local.get(['api_base_url', 'capture_token']);
  return {
    apiBase: items.api_base_url || DEFAULT_API_BASE,
    token: items.capture_token || '',
  };
}

// ── API Client ───────────────────────────────────────────────────
async function callApi(endpoint, body, tabId) {
  const { apiBase, token } = await getConfig();

  if (!token) {
    showError('Token 未配置，请在插件选项中设置', tabId);
    return { success: false, error: 'Token 未配置' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 401) {
      showError('Token 无效，请在插件选项中更新', tabId);
      return { success: false, error: 'Token 无效' };
    }

    const data = await response.json();

    if (response.ok) {
      showSuccess(data.file_slug || data.id || '', tabId);
      console.log('[Cloud Vault] Saved:', data.file_slug || data.id);
      // Server reachable — opportunistically drain any queued captures
      flushRetryQueue();
      return data;
    }

    showError(data.detail || `服务器错误 ${response.status}`, tabId);
    return { success: false, error: data.detail || `HTTP ${response.status}` };
  } catch (err) {
    // Network failure or timeout: keep the capture, retry later
    const queued = await enqueueFailedCapture(endpoint, body);
    const reason = err.name === 'AbortError' ? '连接超时' : '无法连接服务器';
    if (queued) {
      showError(`${reason}，已存入队列稍后自动补传`, tabId);
      return { success: false, queued: true, error: `${reason}（已入队）` };
    }
    showError(`${reason}，请检查 API 地址配置`, tabId);
    return { success: false, error: reason };
  }
}

// ── Offline Retry Queue ──────────────────────────────────────────
// Captures that failed on network errors are kept in storage and
// re-posted by a periodic alarm (and opportunistically after any
// successful capture). Backend dedup makes re-posting safe.
const QUEUE_KEY = 'retry_queue';
const QUEUE_MAX = 50;
const QUEUE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // drop after 48h
const RETRY_ALARM = 'cv-retry-queue';

async function getQueue() {
  const items = await chrome.storage.local.get([QUEUE_KEY]);
  return Array.isArray(items[QUEUE_KEY]) ? items[QUEUE_KEY] : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function enqueueFailedCapture(endpoint, body) {
  try {
    const queue = await getQueue();
    queue.push({
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      endpoint,
      body,
      queued_at: Date.now(),
      attempts: 0,
    });
    // Cap size: drop oldest first
    while (queue.length > QUEUE_MAX) queue.shift();
    await setQueue(queue);
    return true;
  } catch (err) {
    console.error('[Cloud Vault] enqueue failed:', err.message);
    return false;
  }
}

let flushInProgress = false;

async function flushRetryQueue() {
  if (flushInProgress) return { flushed: 0, remaining: -1 };
  flushInProgress = true;
  try {
    const { apiBase, token } = await getConfig();
    let queue = await getQueue();
    if (!queue.length || !token) {
      return { flushed: 0, remaining: queue.length };
    }

    const now = Date.now();
    const keep = [];
    let flushed = 0;

    for (const item of queue) {
      if (now - item.queued_at > QUEUE_MAX_AGE_MS) continue; // expired

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(`${apiBase}${item.endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(item.body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          flushed++;
        } else if (response.status === 401 || response.status >= 500 || response.status === 429) {
          // Recoverable (bad token can be fixed, server may come back)
          item.attempts++;
          keep.push(item);
        }
        // Other 4xx: permanent rejection, drop silently
      } catch (_) {
        item.attempts++;
        keep.push(item);
      }
    }

    await setQueue(keep);
    if (flushed > 0) {
      showNotification('Cloud Vault 补传完成', `已补传 ${flushed} 条离线采集`);
      console.log('[Cloud Vault] retry queue flushed:', flushed, 'remaining:', keep.length);
    }
    return { flushed, remaining: keep.length };
  } finally {
    flushInProgress = false;
  }
}

function ensureRetryAlarm() {
  chrome.alarms?.create?.(RETRY_ALARM, { periodInMinutes: 5 });
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) flushRetryQueue();
});

chrome.runtime.onStartup?.addListener(() => {
  ensureRetryAlarm();
  flushRetryQueue();
});

// ── Badge ────────────────────────────────────────────────────────
function showBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' });
  }, 8000);
}

function showNotification(title, message) {
  chrome.notifications?.create?.(
    {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.log(
          '[Cloud Vault] notification skipped:',
          chrome.runtime.lastError.message,
        );
      }
    },
  );
}

// Page-embedded toast as fallback (notifications may be blocked on Windows)
async function showPageToast(tabId, type, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (_type, _msg) => {
        const toast = document.createElement('div');
        toast.textContent = _msg;
        toast.style.cssText =
          'position:fixed;top:16px;right:16px;z-index:2147483647;padding:10px 18px;' +
          'border-radius:6px;font:13px/1.4 system-ui,sans-serif;color:#fff;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.2);pointer-events:none;animation:cvFadeOut .3s 4.7s forwards;' +
          (_type === 'error' ? 'background:#e74c3c;' : 'background:#27ae60;');
        const style = document.createElement('style');
        style.textContent = '@keyframes cvFadeOut{to{opacity:0;transform:translateY(-8px);}}';
        document.head.appendChild(style);
        document.body.appendChild(toast);
        setTimeout(() => {
          toast.remove();
          style.remove();
        }, 5200);
      },
      args: [type, message],
    });
  } catch (_) {
    // page may not allow scripting (chrome://, etc.)
  }
}

function showError(msg, tabId) {
  console.error('[Cloud Vault]', msg);
  const tid = tabId;
  if (tid) {
    showBadge(tid, 'ERR', '#e74c3c');
    showPageToast(tid, 'error', msg);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        showBadge(tab.id, 'ERR', '#e74c3c');
        showPageToast(tab.id, 'error', msg);
      }
    });
  }
  showNotification('Cloud Vault 保存失败', msg);
}

function showSuccess(fileSlug, tabId) {
  const msg = fileSlug || '捕获成功';
  const tid = tabId;
  if (tid) {
    showBadge(tid, 'OK', '#27ae60');
    showPageToast(tid, 'success', '已保存: ' + msg);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        showBadge(tab.id, 'OK', '#27ae60');
        showPageToast(tab.id, 'success', '已保存: ' + msg);
      }
    });
  }
  showNotification('Cloud Vault 已保存', msg);
}

// ── Content Script Injection ─────────────────────────────────────
async function ensureContentScript(tabId) {
  // Try to ping — if content script responds, it's already loaded
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.pong) return true;
  } catch (_) {
    // not loaded, inject it
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/readability.js', 'content.js'],
    });
    // Give it a moment to initialize
    await new Promise(r => setTimeout(r, 100));
    return true;
  } catch (err) {
    console.error('[Cloud Vault] Failed to inject content script:', err.message);
    return false;
  }
}

// ── SHA-256 ──────────────────────────────────────────────────────
async function hashText(text) {
  const normalized = text.trim();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Capture Actions ──────────────────────────────────────────────

async function capturePage(tab) {
  try {
    // Ensure content script is loaded before messaging
    const ok = await ensureContentScript(tab.id);
    if (!ok) {
      return { success: false, error: '无法在此页面注入内容脚本（可能是受保护页面）' };
    }

    // Get page metadata from content script
    const contentResult = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTENT' });
    if (!contentResult?.success || !contentResult?.data) {
      return { success: false, error: 'Failed to extract page content' };
    }

    const data = contentResult.data;
    const contentHash = await hashText(data.content);

    // Get user preferences from storage
    const items = await chrome.storage.local.get(['tags', 'priority', 'research_intent', 'user_notes']);

    const body = {
      url: data.url,
      title: data.title,
      content: data.content,
      content_hash: contentHash,
      canonical_url: data.canonicalUrl || null,
      tags: items.tags || [],
      priority: items.priority || 'normal',
      research_intent: items.research_intent || '',
      user_notes: items.user_notes || '',
      raw_html: data.rawHtml || null,
      author: data.byline || null,
      published_at: data.publishedAt || null,
    };

    return await callApi('/capture/page', body, tab.id);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function captureSelection(tab) {
  try {
    // Ensure content script is loaded before messaging
    const ok = await ensureContentScript(tab.id);
    if (!ok) {
      return { success: false, error: '无法在此页面注入内容脚本（可能是受保护页面）' };
    }

    // Get selection text from content script
    const selResult = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
    if (!selResult?.text) {
      return { success: false, error: 'No text selected' };
    }

    const infoResult = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
    const url = infoResult?.url || tab.url;
    const pageTitle = infoResult?.title || '';
    const title = `Selection from: ${pageTitle || url}`;
    const contentHash = await hashText(selResult.text);

    const items = await chrome.storage.local.get(['tags', 'priority', 'research_intent', 'user_notes']);

    const body = {
      url,
      title,
      content: selResult.text,
      content_hash: contentHash,
      context_page_url: url,
      tags: items.tags || [],
      priority: items.priority || 'normal',
      research_intent: items.research_intent || '',
      user_notes: items.user_notes || '',
    };

    return await callApi('/capture/selection', body, tab.id);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function captureLink(linkUrl, linkText, contextUrl, contextTitle) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: 'No active tab' };

  const items = await chrome.storage.local.get(['tags', 'priority', 'research_intent', 'user_notes']);

  const body = {
    url: linkUrl,
    title: linkText || linkUrl,
    link_text: linkText,
    context_page_url: contextUrl || tab.url,
    context_page_title: contextTitle,
    tags: items.tags || [],
    priority: items.priority || 'normal',
    research_intent: items.research_intent || '',
    user_notes: items.user_notes || '',
  };

  return await callApi('/capture/link', body, tab.id);
}

async function capturePdf(pdfUrl) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: 'No active tab' };

  const filename = pdfUrl.split('/').pop()?.split('?')[0] || null;
  const items = await chrome.storage.local.get(['tags', 'priority', 'research_intent', 'user_notes']);
  const contentHash = await hashText(pdfUrl);

  const body = {
    url: pdfUrl,
    title: filename || pdfUrl,
    filename,
    content_hash: contentHash,
    tags: items.tags || [],
    priority: items.priority || 'normal',
    research_intent: items.research_intent || '',
    user_notes: items.user_notes || '',
  };

  return await callApi('/capture/pdf', body, tab.id);
}

async function captureImage(imageUrl, altText, pageUrl) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: 'No active tab' };

  const items = await chrome.storage.local.get(['tags', 'priority', 'research_intent', 'user_notes']);
  const contentHash = await hashText(imageUrl);

  const body = {
    url: imageUrl,
    title: altText || imageUrl.split('/').pop()?.split('?')[0] || 'Image',
    alt_text: altText || '',
    page_url: pageUrl || tab.url,
    content_hash: contentHash,
    tags: items.tags || [],
    priority: items.priority || 'normal',
    research_intent: items.research_intent || '',
    user_notes: items.user_notes || '',
  };

  return await callApi('/capture/image', body, tab.id);
}

// ── X Bookmarks Export ───────────────────────────────────────────
const X_BOOKMARKS_URL = 'https://x.com/i/bookmarks';
const BATCH_CHUNK_SIZE = 100;

async function startBookmarksExport() {
  const { token } = await getConfig();
  if (!token) {
    return { success: false, error: 'Token 未配置，请先在选项中设置' };
  }

  const tab = await chrome.tabs.create({ url: X_BOOKMARKS_URL, active: true });

  // Inject the collector once the bookmarks page finishes loading
  const onUpdated = (tabId, changeInfo, updatedTab) => {
    if (tabId !== tab.id || changeInfo.status !== 'complete') return;
    if (!/x\.com\/i\/bookmarks/.test(updatedTab.url || '')) return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    // X hydrates after 'complete'; give the timeline a moment
    setTimeout(() => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['collectors/x-bookmarks.js'],
      }).catch((err) => {
        console.error('[Cloud Vault] collector inject failed:', err.message);
        showNotification('Cloud Vault 导出失败', '无法注入采集脚本，请确认已登录 X');
      });
    }, 3000);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  return { success: true, tabId: tab.id };
}

async function uploadBookmarksBatch(items) {
  const { apiBase, token } = await getConfig();
  if (!token) return { success: false, error: 'Token 未配置' };
  if (!items.length) return { success: false, error: '没有可上传的内容' };

  let unique = 0, duplicate = 0, failed = 0;

  for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BATCH_CHUNK_SIZE);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(`${apiBase}/capture/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          items: chunk,
          capture_type: 'post',
          source: 'x_bookmarks',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        failed += chunk.length;
        continue;
      }
      const data = await response.json();
      unique += data.unique || 0;
      duplicate += data.duplicate || 0;
      failed += data.failed || 0;
    } catch (_) {
      failed += chunk.length;
    }
  }

  const summary = `新增 ${unique} 条，已存在 ${duplicate} 条` +
    (failed ? `，失败 ${failed} 条` : '');
  showNotification('Cloud Vault 书签导出完成', summary);
  console.log('[Cloud Vault] bookmarks export:', summary);

  if (unique + duplicate === 0 && failed > 0) {
    return { success: false, error: '全部上传失败，请检查服务器连接', failed };
  }
  return { success: true, unique, duplicate, failed };
}

// ── Context Menus ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  ensureRetryAlarm();
  chrome.contextMenus.create({
    id: 'cv-save-page',
    title: '保存当前页面到 Cloud Vault',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'cv-save-selection',
    title: '保存选中文本到 Cloud Vault',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'cv-save-link',
    title: '保存此链接到 Cloud Vault',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'cv-save-image',
    title: '保存图片到 Cloud Vault',
    contexts: ['image'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let result;
  try {
    switch (info.menuItemId) {
      case 'cv-save-page':
        result = await capturePage(tab);
        break;
      case 'cv-save-selection':
        result = await captureSelection(tab);
        break;
      case 'cv-save-link':
        if (info.linkUrl) {
          const isPdf = /\.pdf(\?|$)/i.test(info.linkUrl);
          if (isPdf) {
            result = await capturePdf(info.linkUrl);
          } else {
            result = await captureLink(
              info.linkUrl,
              info.selectionText || info.linkText || '',
              info.pageUrl,
              '',
            );
          }
        }
        break;
      case 'cv-save-image':
        if (info.srcUrl) {
          result = await captureImage(
            info.srcUrl,
            info.selectionText || '',
            info.pageUrl,
          );
        }
        break;
      default:
        return;
    }
  } catch (err) {
    showError(`操作失败: ${err.message}`, tab?.id);
    return;
  }

  // Show feedback for pre-API errors (API errors are handled inside callApi)
  if (result && !result.success) {
    showError(result.error || '保存失败', tab?.id);
  } else if (!result) {
    showError('无响应，请检查插件配置', tab?.id);
  }
});

// ── Keyboard Shortcuts ───────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  let result;
  try {
    if (command === 'save-page') {
      result = await capturePage(tab);
    } else if (command === 'save-selection') {
      result = await captureSelection(tab);
    }
  } catch (err) {
    showError(`快捷键操作失败: ${err.message}`, tab.id);
    return;
  }

  if (result && !result.success) {
    showError(result.error || '保存失败', tab.id);
  }
});

// ── Message Handler (from popup) ─────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      const result = await capturePage(tab);
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'CAPTURE_SELECTION') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      const result = await captureSelection(tab);
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'CAPTURE_LINK') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      const pageInfo = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' }).catch(() => ({}));
      const result = await captureLink(
        message.url,
        message.linkText || '',
        pageInfo?.url || '',
        pageInfo?.title || ''
      );
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'CAPTURE_PDF') {
    chrome.tabs.query({ active: true, currentWindow: true }, async () => {
      const result = await capturePdf(message.url);
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'CAPTURE_IMAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      const result = await captureImage(
        message.url,
        message.altText || '',
        message.pageUrl || tab.url
      );
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'EXPORT_X_BOOKMARKS') {
    startBookmarksExport().then(sendResponse);
    return true;
  }

  if (message.type === 'X_BOOKMARKS_COLLECTED') {
    uploadBookmarksBatch(message.items || []).then(sendResponse);
    return true;
  }

  if (message.type === 'QUEUE_STATUS') {
    getQueue().then((queue) => sendResponse({ success: true, count: queue.length }));
    return true;
  }

  if (message.type === 'FLUSH_QUEUE') {
    flushRetryQueue().then((result) => sendResponse({ success: true, ...result }));
    return true;
  }

  if (message.type === 'GET_RECENT') {
    getConfig().then(async ({ apiBase, token }) => {
      if (!token) {
        sendResponse({ success: false, error: 'Token 未配置' });
        return;
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const limit = Math.min(Math.max(Number(message.limit) || 10, 1), 100);
        const response = await fetch(`${apiBase}/captures/recent?limit=${limit}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.status === 401) {
          sendResponse({ success: false, error: 'Token 无效' });
          return;
        }
        if (!response.ok) {
          sendResponse({ success: false, error: `服务器错误 ${response.status}` });
          return;
        }
        const data = await response.json();
        sendResponse({
          success: true,
          captures: data.captures || [],
          total: data.total || 0,
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.name === 'AbortError' ? '请求超时' : '无法连接服务器',
        });
      }
    });
    return true;
  }

  if (message.type === 'CHECK_CONNECTION') {
    getConfig().then(async ({ apiBase, token }) => {
      try {
        const response = await fetch(`${apiBase}/health`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        sendResponse({
          success: response.ok,
          status: response.ok ? 'ok' : 'error',
          url: apiBase,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true;
  }
});
