const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Exercise the actual postinstall in a child process with real filesystem and
// archive extraction. Only HTTPS responses are replaced; no external service,
// real credential, global package installation or user file is accessed.
function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aah-install-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const temp = path.join(dir, 'temp'), pkg = path.join(dir, 'package');
  fs.mkdirSync(temp); fs.mkdirSync(pkg);
  fs.copyFileSync(path.join(__dirname, '../install.js'), path.join(pkg, 'install.js'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"0.0.0"}');
  const target = path.join(dir, 'unrelated-user-file');
  fs.writeFileSync(target, 'must remain unchanged');
  const payload = path.join(dir, 'payload'); fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'ask-a-human'), '#!/bin/sh\nexit 0\n');
  const archive = path.join(dir, 'archive.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', payload, 'ask-a-human']);
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const preload = path.join(dir, 'network.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const { EventEmitter } = require('node:events');
    const { Readable } = require('node:stream');
    const platform = { darwin:'darwin', linux:'linux', win32:'windows' }[process.platform];
    const arch = { x64:'amd64', arm64:'arm64' }[process.arch];
    const asset = 'ask-a-human_' + platform + '_' + arch + '.tar.gz';
    Date.now = () => 1700000000000;
    for (const name of ['aah-' + process.pid + '-' + asset, 'aah-' + process.pid + '-checksums-' + Date.now() + '.txt']) {
      fs.symlinkSync(process.env.FIXTURE_TARGET, path.join(os.tmpdir(), name));
    }
    require('node:https').get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const checksum = url.endsWith('/checksums.txt');
        const own = fs.readdirSync(os.tmpdir()).find(name => name.startsWith('aah-install-') && fs.lstatSync(path.join(os.tmpdir(), name)).isDirectory());
        if (own && checksum) fs.writeFileSync(process.env.FIXTURE_MODES, JSON.stringify([
          fs.statSync(path.join(os.tmpdir(), own)).mode & 0o777,
          fs.statSync(path.join(os.tmpdir(), own, asset)).mode & 0o777,
        ]));
        if (own && !checksum && process.env.FIXTURE_MODE === 'collision') {
          fs.symlinkSync(process.env.FIXTURE_TARGET, path.join(os.tmpdir(), own, asset));
        }
        const body = checksum
          ? Buffer.from(process.env.FIXTURE_MODE === 'missing-checksum' ? 'not a checksum' : process.env.FIXTURE_DIGEST + '  ' + asset + '\\n')
          : fs.readFileSync(process.env.FIXTURE_ARCHIVE);
        const response = process.env.FIXTURE_MODE === 'aborted' && !checksum
          ? new Readable({ read() { this.push(body.subarray(0, 3)); this.destroy(new Error('fixture response interrupted')); } })
          : Readable.from([body]);
        response.statusCode = 200; response.headers = {};
        callback(response);
      });
      return request;
    };
  `);
  const env = { ...process.env, TMPDIR:temp, TMP:temp, TEMP:temp,
    AAH_BINARY_BASEURL:'https://mirror.example/dl', FIXTURE_TARGET:target,
    FIXTURE_ARCHIVE:archive, FIXTURE_DIGEST:digest, FIXTURE_MODE:mode,
    FIXTURE_MODES:path.join(dir, 'modes.json') };
  delete env.AAH_SKIP_DOWNLOAD; delete env.AAH_BINARY_SHA256;
  if (mode === 'bad-digest') env.AAH_BINARY_SHA256 = '0'.repeat(64);
  if (mode === 'bad-pin') env.AAH_BINARY_SHA256 = 'invalid';
  const result = spawnSync(process.execPath, ['--require', preload, path.join(pkg, 'install.js')], {
    env, encoding:'utf8', timeout:10000,
  });
  assert.ifError(result.error);
  return { dir, pkg, temp, target, result };
}

test('predictable archive and checksum symlinks cannot overwrite an unrelated file', t => {
  const f = fixture(t, 'success');
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'must remain unchanged');
  assert.equal(fs.readFileSync(path.join(f.pkg, 'bin/ask-a-human'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(fs.statSync(path.join(f.pkg, 'bin/ask-a-human')).mode & 0o777, 0o755);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'modes.json'), 'utf8')), [0o700, 0o600]);
  assert.ok(fs.readdirSync(f.temp).every(name => fs.lstatSync(path.join(f.temp, name)).isSymbolicLink()), 'installer removes its own private temporary directory');
});

for (const mode of ['bad-digest', 'bad-pin', 'missing-checksum', 'aborted', 'collision']) {
  test(`${mode} fails closed, preserves unrelated files and cleans temporary data`, t => {
    const f = fixture(t, mode);
    assert.equal(f.result.status, 1, f.result.stdout + f.result.stderr);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'must remain unchanged');
    assert.equal(fs.existsSync(path.join(f.pkg, 'bin/ask-a-human')), false);
    assert.match(f.result.stderr, /@askahuman\/mcp: download\/extract failed:/);
    assert.ok(fs.readdirSync(f.temp).every(name => fs.lstatSync(path.join(f.temp, name)).isSymbolicLink()), 'failure removes private temporary directory');
  });
}
