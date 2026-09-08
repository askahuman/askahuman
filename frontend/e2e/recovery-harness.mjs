// Isolated real-agent/relay harness for session-recovery.mjs. No user browser
// profile, external relay, or persistent user VAPID configuration is used.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.RECOVERY_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(ROOT, 'frontend/package.json'));
const { chromium } = require('playwright');
const { ws: WS, wsServer: WSS } = require('playwright-core/lib/utilsBundle');
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await wait(50); }
  throw new Error('condition timed out');
}

export async function setup({ modules = {} } = {}) {
  const out = await mkdtemp(path.join(tmpdir(), 'aah-recovery-'));
  const basePort = Number(process.env.RECOVERY_PORT || 19080);
  const origin = `http://127.0.0.1:${basePort + 1}`;
  const relayURL = `ws://127.0.0.1:${basePort}/ws`;
  const children = new Set();
  const connections = new Set();
  let server, proxy, browser;
  async function cleanup() {
    for (const child of children) child.kill('SIGTERM');
    for (const c of connections) { c.socket.terminate(); c.upstream.terminate(); }
    await browser?.close();
    for (const host of [server, proxy]) {
      host?.closeAllConnections();
      if (host?.listening) await new Promise((resolve) => host.close(resolve));
    }
    await rm(out, { recursive: true, force: true });
  }
  try {
    let blockAgentUntil = 0;
    let transform = (frame) => frame;
    await mkdir(path.join(out, 'bin'));
    await writeFile(path.join(out, 'bin/open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const agentBinary = process.env.AGENT_BINARY || path.join(out, 'agent');
    const relayBinary = process.env.RELAY_BINARY || path.join(out, 'relay');
    for (const [name, binary, supplied] of [['agent', agentBinary, process.env.AGENT_BINARY], ['relay', relayBinary, process.env.RELAY_BINARY]]) {
      if (!supplied) execFileSync('go', ['build', '-o', binary, `./cmd/${name}`], { cwd: path.join(ROOT, 'backend'), stdio: 'pipe' });
    }
    const fixtures = new Map();
    for (const [name, source] of Object.entries({ devicekey: 'src/lib/devicekey.ts', ...modules })) {
      const entry = path.join(out, `${name}-entry.ts`);
      const bundled = path.join(out, `${name}.js`);
      await writeFile(entry, `export * from ${JSON.stringify(path.join(ROOT, 'frontend', source))};`);
      execFileSync('bun', ['build', entry, '--target=browser', `--outfile=${bundled}`], { cwd: path.join(ROOT, 'frontend'), stdio: 'pipe' });
      fixtures.set(`/__recovery/${name}.js`, await readFile(bundled));
    }
    const relay = spawn(relayBinary, ['-addr', `127.0.0.1:${basePort}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    children.add(relay);
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${basePort}/healthz`)).ok; } catch { return false; } });
    const csp = (await readFile(path.join(ROOT, 'infra/local/nginx-local.conf'), 'utf8')).match(/set \$sec_csp "([^"]+)"/)[1];
    server = createServer(async (req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/app') { res.writeHead(301, { Location: '/app/' }); res.end(); return; }
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Cache-Control', 'no-cache');
      if (fixtures.has(url.pathname)) { res.setHeader('Content-Type', 'text/javascript'); res.end(fixtures.get(url.pathname)); return; }
      const pathname = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
      const file = path.resolve(ROOT, 'frontend/dist', `.${pathname}`);
      if (!file.startsWith(path.join(ROOT, 'frontend/dist') + path.sep)) { res.writeHead(403); res.end(); return; }
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' }[path.extname(file)];
      try { res.setHeader('Content-Type', mime || 'application/octet-stream'); res.end(await readFile(file)); }
      catch { res.writeHead(404); res.end(); }
    });
    proxy = createServer();
    for (const [host, agentSide] of [[server, false], [proxy, true]]) {
      const wss = new WSS({ server: host });
      wss.on('connection', (socket, req) => {
        if (agentSide && Date.now() < blockAgentUntil) { socket.close(1013, 'test reconnect interruption'); return; }
        const upstream = new WS(relayURL + new URL(req.url, origin).search);
        const connection = { socket, upstream, agentSide };
        connections.add(connection);
        const queue = [];
        socket.on('message', (raw) => {
          const frame = agentSide ? transform(raw.toString()) : raw.toString();
          if (frame === null) return;
          if (upstream.readyState === WS.OPEN) upstream.send(frame); else queue.push(frame);
        });
        upstream.on('open', () => queue.splice(0).forEach((frame) => upstream.send(frame)));
        upstream.on('message', (raw) => { if (socket.readyState === WS.OPEN) socket.send(raw.toString()); });
        const close = () => { connections.delete(connection); socket.terminate(); upstream.terminate(); };
        socket.on('close', close); upstream.on('close', close);
        socket.on('error', () => {}); upstream.on('error', () => {});
      });
    }
    await new Promise((resolve) => server.listen(basePort + 1, '127.0.0.1', resolve));
    await new Promise((resolve) => proxy.listen(basePort + 2, '127.0.0.1', resolve));
    browser = await chromium.launch(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' });
    async function mcp(name = 'recovery-test') {
      // Model independent machines: each process signs pushes with its own key.
      const vapid = createECDH('prime256v1'); vapid.generateKeys();
      const processAgent = spawn(agentBinary, ['serve', '--relay', `ws://127.0.0.1:${basePort + 2}/ws`, '--name', name], {
        env: { ...process.env, PATH: `${path.join(out, 'bin')}:${process.env.PATH}`, AAH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'), AAH_VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'), AAH_REQUIRE_DEVICE_SIG: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(processAgent);
      let stderr = '', pendingOutput = '', seq = 0;
      const pending = new Map();
      processAgent.stderr.on('data', (data) => { stderr += data; });
      processAgent.on('exit', () => children.delete(processAgent));
      processAgent.stdout.on('data', (data) => {
        pendingOutput += data;
        let newline;
        while ((newline = pendingOutput.indexOf('\n')) >= 0) {
          const line = pendingOutput.slice(0, newline); pendingOutput = pendingOutput.slice(newline + 1);
          try { const message = JSON.parse(line); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } } catch {}
        }
      });
      const call = (method, params = {}) => new Promise((resolve) => {
        const id = ++seq; pending.set(id, resolve);
        processAgent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'recovery-test', version: '1' } });
      processAgent.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return {
        tool: (name, args = {}) => call('tools/call', { name, arguments: args }),
        code: async () => { await until(() => /Pairing code:\s*(\S+)/.test(stderr)); return stderr.match(/Pairing code:\s*(\S+)/)[1]; },
        kill: () => processAgent.kill('SIGTERM'),
      };
    }
    return {
      origin, browser, mcp,
      tamperConfirmation: (enabled) => { transform = enabled ? (frame) => JSON.parse(frame).confirm ? JSON.stringify({ confirm: Buffer.alloc(32).toString('base64') }) : frame : (frame) => frame; },
      cutAgent: () => {
        blockAgentUntil = Date.now() + 600;
        let count = 0;
        for (const c of connections) if (c.agentSide) { count++; c.socket.terminate(); c.upstream.terminate(); }
        return count;
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
