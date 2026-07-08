// Cloud Vault Capture — Content Script
// Extracts page content via Readability + platform-specific for X/YouTube

(() => {
  'use strict';

  // ── Platform Detection ─────────────────────────────────────────
  function detectPlatform(url) {
    if (/x\.com|twitter\.com/.test(url)) return 'x';
    if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
    return 'generic';
  }

  // ── DOM Helpers ────────────────────────────────────────────────
  // SPA pages (X) render content after document_idle; poll until the
  // selector appears or the timeout elapses (resolves null, no throw).
  function waitForSelector(selector, timeout = 5000, interval = 250) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - startedAt >= timeout) return resolve(null);
        setTimeout(check, interval);
      };
      check();
    });
  }

  // ── Generic Page Extraction ────────────────────────────────────
  function extractGeneric() {
    try {
      const canonical = document.querySelector('link[rel="canonical"]');
      const authorMeta = document.querySelector('meta[name="author"]');
      const publishedMeta = document.querySelector('meta[property="article:published_time"]');

      // Try Readability if available, otherwise fall back to basic extraction
      let title = document.title || '';
      let content = (document.body?.innerText || '').slice(0, 50000);
      let byline = authorMeta?.getAttribute('content') || null;
      let excerpt = '';

      if (typeof Readability !== 'undefined') {
        try {
          const documentClone = document.cloneNode(true);
          const article = new Readability(documentClone, {
            charThreshold: 100,
          }).parse();
          title = article?.title || title;
          content = article?.textContent || content;
          excerpt = article?.excerpt || '';
          byline = article?.byline || byline;
        } catch (_) {
          // Readability failed, use basic extraction
        }
      }

      return {
        title,
        content,
        excerpt,
        byline,
        siteName: null,
        canonicalUrl: canonical?.getAttribute('href') || null,
        publishedAt: publishedMeta?.getAttribute('content') || null,
        platform: 'web',
      };
    } catch (err) {
      return {
        title: document.title || '',
        content: (document.body?.innerText || '').slice(0, 50000),
        platform: 'web',
      };
    }
  }

  // ── X.com Extraction ───────────────────────────────────────────
  async function extractXContent() {
    try {
      // Wait for the SPA to render the tweet before extracting
      await waitForSelector('article [data-testid="tweetText"]');

      // Scope to <article> to avoid picking up sidebar recommendations
      const tweetEl = document.querySelector('article [data-testid="tweetText"]');
      const authorEl = document.querySelector('article [data-testid="User-Name"]');
      const timeEl = document.querySelector('article time');
      const tweetText = tweetEl?.innerText || '';
      const author = authorEl?.innerText?.split('\n')[0] || null;
      const time = timeEl?.getAttribute('datetime') || null;

      // Try to get the thread context
      const contextTweets = Array.from(
        document.querySelectorAll('article [data-testid="tweetText"]')
      ).map(el => el.innerText).join('\n\n---\n\n');

      // Never return empty content — 422s on the backend otherwise
      const content = contextTweets || tweetText
        || document.body?.innerText?.slice(0, 10000) || '';

      return {
        title: tweetText
          ? tweetText.slice(0, 80) + (tweetText.length > 80 ? '...' : '')
          : (document.title || 'X Post'),
        content,
        byline: author,
        publishedAt: time,
        platform: 'x',
        siteName: 'X.com',
      };
    } catch (err) {
      return {
        title: document.title || 'X Post',
        content: document.body?.innerText?.slice(0, 10000) || '',
        platform: 'x',
      };
    }
  }

  // ── YouTube Extraction ─────────────────────────────────────────
  function extractYoutubeContent() {
    try {
      const title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
        || document.querySelector('#title h1')?.textContent?.trim()
        || document.title.replace(' - YouTube', '');
      const channel = document.querySelector('#owner a, ytd-channel-name a')?.textContent?.trim();
      const description = document.querySelector('#description-inline-expander, ytd-expander #description')?.textContent?.trim();

      return {
        title: title || 'YouTube Video',
        content: [
          `Channel: ${channel || '_unknown_'}`,
          `URL: ${location.href}`,
          '',
          'Description:',
          description || '_no description_',
        ].join('\n'),
        byline: channel,
        platform: 'youtube',
        siteName: 'YouTube',
      };
    } catch (err) {
      return {
        title: document.title.replace(' - YouTube', ''),
        content: `URL: ${location.href}`,
        platform: 'youtube',
      };
    }
  }

  // ── Main Extraction ────────────────────────────────────────────
  // Cap raw HTML client-side: news/report pages inline scripts and
  // base64 images into multi-MB documents that fail in transit. The
  // backend truncates at 1MB on disk anyway.
  const MAX_RAW_HTML_CHARS = 500000;

  async function extractContent() {
    const platform = detectPlatform(location.href);
    let result;
    if (platform === 'x') result = await extractXContent();
    else if (platform === 'youtube') result = extractYoutubeContent();
    else result = extractGeneric();

    result.platform = platform;
    result.url = location.href;

    // Also grab raw HTML for generic pages
    if (platform === 'generic') {
      const rawHtml = document.documentElement.outerHTML;
      result.rawHtml = rawHtml.length > MAX_RAW_HTML_CHARS
        ? rawHtml.slice(0, MAX_RAW_HTML_CHARS) +
          '\n<!-- [Content truncated at 500000 chars] -->'
        : rawHtml;
    }

    return result;
  }

  // ── Message Listener ───────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ pong: true });
      return false;
    }

    if (message.type === 'EXTRACT_CONTENT') {
      // Async: keep the message channel open for the SPA wait
      (async () => {
        try {
          const result = await extractContent();
          sendResponse({ success: true, data: result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === 'GET_SELECTION') {
      const selection = window.getSelection()?.toString()?.trim() || '';
      sendResponse({ success: true, text: selection });
      return false;
    }

    if (message.type === 'GET_PAGE_INFO') {
      sendResponse({
        success: true,
        url: location.href,
        title: document.title,
      });
      return false;
    }
  });
})();
