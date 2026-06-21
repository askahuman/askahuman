// render-pair-page.mjs — write a full-screen, scannable pairing page.
//
// A small QR in Preview is hard to scan off a laptop screen; this renders a LOW-density
// (ECC 'L') QR as a big data-URL image that fills the browser window, plus the manual code
// and a copyable deep link as fallback. The MCP launcher (scripts/mcp-serve-lan.sh) opens
// the resulting HTML in the default browser whenever an agent requests approval.
//
// Usage: node render-pair-page.mjs <deep-link-url> <code> <out.html>   (run from anywhere)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

// qrcode lives in frontend/node_modules; resolve it from there regardless of cwd.
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const QRCode = require('qrcode');

const [, , rawUrl, code = '', out] = process.argv;
if (!rawUrl || !out) {
  console.error('usage: render-pair-page.mjs <url> <code> <out.html>');
  process.exit(2);
}

// QR-scanned URLs lose the "#p=" fragment on iOS, so encode the payload as a "?p="
// query instead (the PWA reads both). Clicked links may still use "#p=".
// The PWA now lives at /app, so the deep link is e.g. ".../app#p=<payload>";
// rewrite only the "#p=" -> "?p=" fragment marker, path-agnostically.
const url = rawUrl.replace('#p=', '?p=');

// ECC 'L' = fewer modules for the same data = larger modules at a given size = easier to scan.
const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'L', margin: 2, width: 1024 });

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ask-a-human · pair</title></head>
<body style="margin:0;background:#fff;height:100vh;display:flex;flex-direction:column;
align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;color:#111">
  <img src="${dataUrl}" alt="pairing QR"
       style="width:min(88vw,80vh);height:auto;image-rendering:pixelated">
  <div style="margin-top:14px;font-size:22px">Scan with the iPhone <b>Camera app</b></div>
  <div style="margin-top:4px;font-size:18px;color:#555">manual code: <b style="letter-spacing:1px">${code}</b></div>
  <a href="${url}" style="margin-top:10px;font-size:13px;color:#0a58ca;word-break:break-all;max-width:88vw;text-align:center">${url}</a>
</body></html>`;

writeFileSync(out, html);
console.error('pair page written:', out);
