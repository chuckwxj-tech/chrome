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
      return data;
    }

    showError(data.detail || `服务器错误 ${response.status}`, tabId);
    return { success: false, error: data.detail || `HTTP ${response.status}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      showError('连接超时，请检查服务器是否在线', tabId);
      return { success: false, error: '请求超时' };
    }
    showError('无法连接到 Cloud Vault 服务器，请检查 API 地址配置', tabId);
    return { success: false, error: '无法连接' };
  }
}

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

// ── Context Menus ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
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
