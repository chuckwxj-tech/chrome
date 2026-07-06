// Cloud Vault Capture — X Bookmarks Collector
// Injected on demand into x.com/i/bookmarks. Auto-scrolls at a human
// pace, extracts tweets from the virtualized timeline as they render,
// then hands the batch to the service worker for upload.

(() => {
  'use strict';

  if (window.__cvBookmarksCollectorRunning) return;
  window.__cvBookmarksCollectorRunning = true;

  // All X DOM selectors live here — when X ships a redesign, fix this block only.
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    // The permalink is the <a> wrapping the <time> element
    timeLink: 'a[href*="/status/"] time',
  };

  const SCROLL_INTERVAL_MS = () => 1200 + Math.random() * 900; // human pace
  const IDLE_ROUNDS_TO_STOP = 6;   // consecutive rounds with no new tweets
  const MAX_ITEMS = 2000;          // safety cap

  const collected = new Map();     // url -> item
  let stopped = false;

  // ── Overlay UI ─────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483647;padding:12px 16px;' +
    'border-radius:8px;background:#1a1a2e;color:#fff;font:13px/1.5 system-ui,sans-serif;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.35);min-width:220px;';
  const statusLine = document.createElement('div');
  statusLine.textContent = 'Cloud Vault: 开始采集书签...';
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '停止并上传';
  stopBtn.style.cssText =
    'margin-top:8px;padding:4px 10px;border:none;border-radius:5px;cursor:pointer;' +
    'background:#1d9bf0;color:#fff;font-size:12px;';
  stopBtn.addEventListener('click', () => { stopped = true; });
  overlay.appendChild(statusLine);
  overlay.appendChild(stopBtn);
  document.body.appendChild(overlay);

  function setStatus(text, done) {
    statusLine.textContent = text;
    if (done) {
      stopBtn.remove();
      setTimeout(() => overlay.remove(), 10000);
      window.__cvBookmarksCollectorRunning = false;
    }
  }

  // ── Extraction ─────────────────────────────────────────────────
  function extractVisible() {
    let added = 0;
    for (const article of document.querySelectorAll(SEL.tweet)) {
      try {
        const timeEl = article.querySelector(SEL.timeLink);
        const link = timeEl?.closest('a');
        if (!link) continue;
        const url = new URL(link.getAttribute('href'), location.origin).href;
        if (collected.has(url)) continue;

        const text = article.querySelector(SEL.tweetText)?.innerText || '';
        const author =
          article.querySelector(SEL.userName)?.innerText?.split('\n')[0] || null;
        const publishedAt = timeEl?.getAttribute('datetime') || null;

        collected.set(url, {
          url,
          title: `${author || 'X'}: ${text.slice(0, 80) || url}`,
          content: text,
          author,
          published_at: publishedAt,
          tags: ['X书签'],
        });
        added++;
      } catch (_) {
        // one malformed card must not kill the run
      }
    }
    return added;
  }

  // ── Scroll loop ────────────────────────────────────────────────
  async function run() {
    let idleRounds = 0;

    while (!stopped && collected.size < MAX_ITEMS) {
      const added = extractVisible();
      setStatus(`Cloud Vault: 已采集 ${collected.size} 条书签...`);

      const beforeY = window.scrollY;
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await new Promise((r) => setTimeout(r, SCROLL_INTERVAL_MS()));

      if (added === 0 && Math.abs(window.scrollY - beforeY) < 4) {
        idleRounds++;
        if (idleRounds >= IDLE_ROUNDS_TO_STOP) break; // bottom reached
      } else {
        idleRounds = 0;
      }
    }
    extractVisible(); // final sweep

    const items = Array.from(collected.values());
    if (!items.length) {
      setStatus('Cloud Vault: 未找到书签（页面未加载完或选择器失效）', true);
      return;
    }

    setStatus(`Cloud Vault: 采集完成 ${items.length} 条，上传中...`);
    stopBtn.remove();

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'X_BOOKMARKS_COLLECTED',
        items,
      });
      if (result?.success) {
        const parts = [];
        if (result.unique) parts.push(`新增 ${result.unique} 条`);
        if (result.duplicate) parts.push(`已存在 ${result.duplicate} 条`);
        if (result.queued) parts.push(`${result.queued} 条已入队，服务器恢复后自动补传`);
        if (result.failed) parts.push(`失败 ${result.failed} 条`);
        setStatus(`Cloud Vault: 完成 — ${parts.join('，')}`, true);
      } else {
        setStatus(`Cloud Vault: 上传失败 — ${result?.error || '未知错误'}`, true);
      }
    } catch (err) {
      setStatus(`Cloud Vault: 上传失败 — ${err.message}`, true);
    }
  }

  run();
})();
