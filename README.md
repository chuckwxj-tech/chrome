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

## Verify

```sh
python3 -m json.tool manifest.json >/dev/null
node --check background.js content.js options/options.js popup/popup.js
```
