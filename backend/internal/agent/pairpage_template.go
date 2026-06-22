package agent

import "html/template"

// pageData fills pairHTML. Code is the grouped human-facing pairing code (e.g.
// "4F2K-9QHR") rendered into the page BODY only; it never appears in a URL.
// StatusPath is the same-origin poll endpoint the tab hits to learn when the
// handshake completed. Paired pre-renders the connected state for the rare case
// the human reloads after pairing.
type pageData struct {
	Code       string
	AppURL     string
	StatusPath string
	Paired     bool
}

// pageTmpl is the loopback pairing page. The palette, fonts, and layout mirror
// the PWA PairScreen (frontend/src/components/PairScreen.tsx + theme.ts dark
// palette) so the surface the human sees on their desktop matches the one on
// their phone. It is fully self-contained: inline CSS + JS, no external fetch
// (enforced by the page's default-src 'none' CSP), so it renders offline and
// leaks nothing to a third party.
var pageTmpl = template.Must(template.New("pairpage").Parse(pairHTML))

const pairHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>ask-a-human — pair a device</title>
<style>
  :root {
    --bg: #0c0d11; --surface: #15171d; --surface2: #1b1e26;
    --border: #2a2e38; --text: #e9ebf0; --muted: #8b919d; --faint: #5b616c;
    --approve: #39d98a; --approve-dim: rgba(57,217,138,0.14);
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "IBM Plex Sans", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text); font-family: var(--mono);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 18px;
    padding: 30px 26px 26px; transition: border-color .3s ease;
  }
  .kicker { font-size: 11px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; }
  .title { font-size: 25px; font-weight: 700; margin-top: 8px; }
  .sub { font-family: var(--sans); font-size: 13.5px; color: var(--muted); margin-top: 10px; line-height: 1.55; }
  .codebox {
    margin-top: 24px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 14px; padding: 22px 12px; text-align: center;
  }
  .code { font-size: 38px; font-weight: 700; letter-spacing: 8px; color: var(--text); }
  .copy {
    margin-top: 14px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    background: transparent; border: 1px solid var(--border); border-radius: 9px;
    padding: 7px 12px; cursor: pointer;
  }
  .copy:hover { color: var(--text); border-color: var(--faint); }
  .steps { font-family: var(--sans); font-size: 13.5px; color: var(--muted); margin-top: 22px; line-height: 1.7; }
  .steps b { color: var(--text); font-weight: 600; }
  .status {
    margin-top: 22px; display: flex; align-items: center; gap: 9px;
    font-size: 13px; color: var(--muted);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--approve); }
  .status.waiting .dot { animation: blink 1.4s infinite; }
  .foot { font-family: var(--sans); font-size: 12px; color: var(--faint); text-align: center; margin-top: 22px; line-height: 1.5; }
  /* Connected state. */
  body.paired .card { border-color: var(--approve); }
  body.paired .status { color: var(--approve); }
  body.paired .codebox { opacity: .5; }
  .hidden { display: none; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
</style>
</head>
<body{{if .Paired}} class="paired"{{end}}>
  <div class="card">
    <div class="kicker">ask-a-human</div>
    <div class="title">Pair a device</div>
    <div class="sub">Your agent wants to reach you. Enter this code on your phone to connect — end-to-end encrypted, no account.</div>

    <div class="codebox">
      <div class="code" id="code">{{ .Code }}</div>
      <button class="copy" id="copy" type="button">copy code</button>
    </div>

    <div class="steps">
      <div>1. On your phone, open <b>{{ .AppURL }}</b></div>
      <div>2. Type the code above and tap <b>Connect</b></div>
    </div>

    <div class="status waiting" id="status">
      <span class="dot"></span>
      <span id="status-text">waiting for your phone…</span>
    </div>

    <div class="foot">The code is the key — it derives the room and encrypts the channel. It never leaves this machine in a link.</div>
  </div>

<script>
(function () {
  var STATUS = {{ .StatusPath }};
  var statusEl = document.getElementById('status');
  var textEl = document.getElementById('status-text');
  var timer = null;

  document.getElementById('copy').addEventListener('click', function () {
    var code = document.getElementById('code').textContent;
    try { navigator.clipboard.writeText(code); this.textContent = 'copied'; } catch (e) { /* ignore */ }
  });

  function connected() {
    if (timer) clearInterval(timer);
    document.body.classList.add('paired');
    statusEl.classList.remove('waiting');
    textEl.textContent = 'Connected — you can close this tab';
    // Best effort: browsers only let a script close a tab it opened, so this may
    // be ignored. The "you can close this tab" copy covers that case.
    setTimeout(function () { try { window.close(); } catch (e) { /* ignore */ } }, 1200);
  }

  function poll() {
    fetch(STATUS, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s && s.paired) connected(); })
      .catch(function () { /* keep last state on a blip */ });
  }

  if ({{ .Paired }}) { connected(); }
  else { timer = setInterval(poll, 1200); poll(); }
})();
</script>
</body>
</html>`
