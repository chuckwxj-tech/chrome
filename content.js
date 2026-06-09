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
  function extractXContent() {
    try {
      const tweetEl = document.querySelector('[data-testid="tweetText"]');
      const authorEl = document.querySelector('[data-testid="User-Name"]');
      const timeEl = document.querySelector('time');
      const tweetText = tweetEl?.innerText || '';
      const author = authorEl?.innerText?.split('\n')[0] || null;
      const time = timeEl?.getAttribute('datetime') || null;

      // Try to get the thread context
      const contextTweets = Array.from(
        document.querySelectorAll('[data-testid="tweetText"]')
      ).map(el => el.innerText).join('\n\n---\n\n');

      return {
        title: tweetText.slice(0, 80) + (tweetText.length > 80 ? '...' : ''),
        content: contextTweets || tweetText,
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
  function extractContent() {
    const platform = detectPlatform(location.href);
    let result;
    if (platform === 'x') result = extractXContent();
    else if (platform === 'youtube') result = extractYoutubeContent();
    else result = extractGeneric();

    result.platform = platform;
    result.url = location.href;

    // Also grab raw HTML for generic pages
    if (platform === 'generic') {
      result.rawHtml = document.documentElement.outerHTML;
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
      try {
        const result = extractContent();
        sendResponse({ success: true, data: result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
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
