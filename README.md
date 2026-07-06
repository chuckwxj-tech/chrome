# Cloud Vault Capture

Manifest V3 Chrome extension for saving pages, selected text, and links to a Cloud Vault capture API.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this extension directory.

## Configure

Open the extension options page and set:

- API server base URL
- Capture token

The token is stored in Chrome extension local storage. Do not commit tokens, `.env` files, packed extension archives, or Chrome profile storage files.

## Features

- Capture pages, selections, links, PDFs, and images via popup, context menu, or shortcuts (Alt+S / Alt+Shift+S).
- Popup 「最近捕获」 lists the latest captures from `GET /captures/recent`.
- Entity write-back: after analysis, post structured company mappings to
  `POST /captures/{id}/entities`; query per-capture entities via
  `GET /captures/{id}/entities` and cross-capture mention counts via
  `GET /entities/stats?limit=50&since=YYYY-MM-DD`.
- `deploy/ingest_browser_captures.py` routes captures per
  `deploy/browser-capture-rules.json` (route enable flags, per-priority
  `extra_routes`, and `notify` — urgent captures append to
  `logs/content-capture/notifications.jsonl`). Override with `--rules`,
  `--vault-root`, or `CLOUD_VAULT_ROOT`.

## Verify

```sh
python3 -m json.tool manifest.json >/dev/null
node --check background.js content.js options/options.js popup/popup.js
```
