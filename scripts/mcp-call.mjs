// mcp-call.mjs — minimal MCP stdio client that calls request_approval once.
// Diagnostic / control driver for the agent side (no LLM): spawns the launcher, does the
// MCP handshake, calls the tool, prints the structured result as JSON, exits. Keeps stdin
// open until the call returns so the server never sees a premature EOF.
//
// env: LAUNCH (path to mcp launcher), KIND (yesno|choice|text)
import { spawn } from 'node:child_process';

const LAUNCH = process.env.LAUNCH ?? new URL('./mcp-serve-test.sh', import.meta.url).pathname;
const KIND = process.env.KIND ?? 'yesno';
const args = {
  yesno:  { title: 'Production deploy', category: 'deploy', summary: 'Deploy v2.3.1 to prod?', response_kind: 'yesno' },
  choice: { title: 'Pick a lane', category: 'deploy', summary: 'Proceed or hold?', response_kind: 'choice', options: ['Proceed', 'Hold'] },
  text:   { title: 'Name the release', category: 'other', summary: 'What should we call it?', response_kind: 'text', placeholder: 'name' },
}[KIND];

const srv = spawn(LAUNCH, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
const send = (msg) => srv.stdin.write(JSON.stringify(msg) + '\n');
const rpc = (id, method, params) => new Promise((res, rej) => { pending.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });

srv.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.id != null && pending.has(o.id)) {
      const { res, rej } = pending.get(o.id); pending.delete(o.id);
      o.error ? rej(new Error(JSON.stringify(o.error))) : res(o.result);
    }
  }
});

const fail = (m) => { console.error('FAIL:', m); srv.kill('SIGTERM'); process.exit(1); };
srv.on('exit', (c) => { if (c) fail(`server exited (${c})`); });

await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '0' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('handshake ok; calling request_approval…');
const result = await rpc(2, 'tools/call', { name: 'request_approval', arguments: args }).catch((e) => fail(`tool call: ${e.message}`));
const structured = result?.structuredContent ?? result?.content ?? result;
console.log('RESULT ' + JSON.stringify(structured));
srv.kill('SIGTERM');
process.exit(0);
