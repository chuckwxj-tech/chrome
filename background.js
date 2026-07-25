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

// FastAPI 422 responses carry `detail` as an array of {loc, msg}
// objects; rendering that directly shows "[object Object]".
function formatErrorDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e) => {
        const loc = (e.loc || []).filter((p) => p !== 'body').join('.');
        return loc ? `${loc}: ${e.msg || ''}` : (e.msg || '');
      })
      .filter(Boolean)
      .join('; ');
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return '';
}

// Proxies and nginx answer with HTML error pages, so response.json()
// throws on exactly the failures we most need to classify. Never let
// that throw escape into the network-error path.
async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

// Describe a non-OK status, and say whether retrying could ever help.
function describeHttpStatus(status, detail) {
  if (status === 413) {
    return { recoverable: false, message: '请求体过大被服务器拒绝 (413)' };
  }
  if (status === 502 || status === 504) {
    return {
      recoverable: true,
      message: `网关错误 (${status}) — 请求可能被代理拦截，请为服务器 IP 配置直连规则`,
    };
  }
  if (status === 404) {
    return {
      recoverable: false,
      message: '接口不存在 (404) — 服务器后端不是最新版本，请更新部署 backend',
    };
  }
  if (status >= 500 || status === 429) {
    return {
      recoverable: true,
      message: `服务器错误 ${status}${detail ? ' — ' + detail : ''}`,
    };
  }
  return {
    recoverable: false,
    message: detail || `服务器错误 ${status}`,
  };
}

async function callApi(endpoint, body, tabId) {
  const { apiBase, token } = await getConfig();

  if (!token) {
    showError('Token 未配置，请在插件选项中设置', tabId);
    return { success: false, error: 'Token 未配置' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutForEndpoint(endpoint));

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

    const data = await readJsonSafely(response);

    if (response.ok) {
      const payload = data || {};
      showSuccess(payload.file_slug || payload.id || '', tabId);
      console.log('[Cloud Vault] Saved:', payload.file_slug || payload.id);
      // Server reachable — opportunistically drain any queued captures
      flushRetryQueue();
      return payload;
    }

    const detail = formatErrorDetail(data?.detail);
    const { recoverable, message } = describeHttpStatus(response.status, detail);
    console.error('[Cloud Vault] http error:', response.status, endpoint, message);

    if (recoverable && (await enqueueFailedCapture(endpoint, body))) {
      showError(`${message}，已存入队列稍后自动补传`, tabId);
      return { success: false, queued: true, error: `${message}（已入队）` };
    }
    showError(message, tabId);
    return { success: false, error: message };
  } catch (err) {
    console.error('[Cloud Vault] fetch error:', err.name, err.message, endpoint);
    // Network failure or timeout: keep the capture, retry later
    const queued = await enqueueFailedCapture(endpoint, body);
    let reason;
    if (err.name === 'AbortError') {
      reason = '连接超时';
    } else if (/Failed to fetch|NetworkError/i.test(err.message || '')) {
      reason = '无法连接服务器（后端未启动或网络不可达）';
    } else {
      reason = `无法连接服务器: ${err.message || '未知网络错误'}`;
    }
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
const QUEUE_MAX_BYTES = 4 * 1024 * 1024; // stay well under the 10MB storage quota
const QUEUE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // drop after 48h
const QUEUE_MAX_ATTEMPTS = 12;
const RETRY_ALARM = 'cv-retry-queue';

// Page captures carry raw_html (up to 500k chars) and bookmark chunks
// carry up to 100 tweets, so an unbounded queue can blow the extension
// storage quota. Trim oldest-first until it fits by count and by bytes.
function trimQueue(queue) {
  while (queue.length > QUEUE_MAX) queue.shift();
  while (queue.length > 1 && JSON.stringify(queue).length > QUEUE_MAX_BYTES) {
    queue.shift();
  }
  return queue;
}

function timeoutForEndpoint(endpoint) {
  // Batch uploads carry up to 100 items; they need a bigger budget than
  // a single capture, on the first attempt and on every retry alike.
  return endpoint === '/capture/batch' ? 60000 : 15000;
}

async function getQueue() {
  const items = await chrome.storage.local.get([QUEUE_KEY]);
  return Array.isArray(items[QUEUE_KEY]) ? items[QUEUE_KEY] : [];
}

// Never throws: on a quota error, sheds the oldest half and retries once.
async function setQueue(queue) {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: trimQueue(queue) });
    return true;
  } catch (err) {
    console.error('[Cloud Vault] queue write failed:', err.message);
    try {
      const halved = queue.slice(Math.ceil(queue.length / 2));
      await chrome.storage.local.set({ [QUEUE_KEY]: halved });
      console.warn('[Cloud Vault] queue shrunk to', halved.length, 'entries');
      return true;
    } catch (err2) {
      console.error('[Cloud Vault] queue write failed again:', err2.message);
      return false;
    }
  }
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
    return await setQueue(queue);
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
      if ((item.attempts || 0) >= QUEUE_MAX_ATTEMPTS) {
        console.warn('[Cloud Vault] dropping queue entry after',
          item.attempts, 'attempts:', item.endpoint);
        continue;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(), timeoutForEndpoint(item.endpoint));
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
    // Pre-empt the backend's min_length validation with a clear message
    if (!data.content || !String(data.content).trim()) {
      return {
        success: false,
        error: '页面内容为空，可能页面尚未加载完成，请稍后重试',
      };
    }
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

  // Inject the collector once the bookmarks page finishes loading.
  // Every exit path must detach the listeners: if X redirects to login
  // or the user closes the tab, a stray listener would otherwise fire
  // on some unrelated later navigation.
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    clearTimeout(giveUpTimer);
  };

  const onUpdated = (tabId, changeInfo, updatedTab) => {
    if (tabId !== tab.id || changeInfo.status !== 'complete') return;
    if (!/x\.com\/i\/bookmarks/.test(updatedTab.url || '')) return;
    cleanup();
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

  const onRemoved = (tabId) => {
    if (tabId === tab.id) cleanup();
  };

  const giveUpTimer = setTimeout(() => {
    if (settled) return;
    cleanup();
    showNotification('Cloud Vault 导出失败', '书签页未能加载，请确认已登录 X 后重试');
  }, 60000);

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);

  return { success: true, tabId: tab.id };
}

async function uploadBookmarksBatch(items) {
  const { apiBase, token } = await getConfig();
  if (!token) return { success: false, error: 'Token 未配置' };
  if (!items.length) return { success: false, error: '没有可上传的内容' };

  let unique = 0, duplicate = 0, failed = 0, queued = 0;
  let lastError = '';

  for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BATCH_CHUNK_SIZE);
    const payload = { items: chunk, capture_type: 'post', source: 'x_bookmarks' };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(`${apiBase}/capture/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        unique += data.unique || 0;
        duplicate += data.duplicate || 0;
        failed += data.failed || 0;
        continue;
      }

      const data = await readJsonSafely(response);
      const detail = formatErrorDetail(data?.detail);
      // 401 is recoverable here too: fixing the token drains the queue
      const { recoverable, message } = response.status === 401
        ? { recoverable: true, message: 'Token 无效，请在插件选项中更新' }
        : describeHttpStatus(response.status, detail);
      lastError = message;

      if (recoverable && (await enqueueFailedCapture('/capture/batch', payload))) {
        queued += chunk.length;
      } else {
        failed += chunk.length;
      }
    } catch (err) {
      lastError = err.name === 'AbortError' ? '请求超时' : '无法连接服务器';
      await enqueueFailedCapture('/capture/batch', payload);
      queued += chunk.length;
    }
  }

  const parts = [];
  if (unique) parts.push(`新增 ${unique} 条`);
  if (duplicate) parts.push(`已存在 ${duplicate} 条`);
  if (queued) parts.push(`${queued} 条已入队自动补传`);
  if (failed) parts.push(`失败 ${failed} 条`);
  const summary = (parts.join('，') || '无结果') + (lastError ? `（${lastError}）` : '');

  const ok = unique + duplicate + queued > 0;
  showNotification(ok ? 'Cloud Vault 书签导出' : 'Cloud Vault 书签导出失败', summary);
  console.log('[Cloud Vault] bookmarks export:', summary);

  if (!ok) {
    return { success: false, error: lastError || '全部上传失败', failed };
  }
  return { success: true, unique, duplicate, failed, queued, error: lastError || undefined };
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
