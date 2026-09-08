const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Windows CI uses Windows PowerShell. Other hosts can opt into the same real
// parser/extractor with a portable PowerShell executable; nothing is installed.
const powershell = process.env.AAH_TEST_POWERSHELL ||
  (process.platform === 'win32' ? 'powershell.exe' : '');
const options = { skip: powershell ? false : 'requires Windows or AAH_TEST_POWERSHELL' };

function fixture(t, segment, corrupt = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aah-windows-path-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, segment);
  const temp = path.join(base, 'temp'), pkg = path.join(base, 'package');
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(pkg);
  fs.copyFileSync(path.join(__dirname, '../install.js'), path.join(pkg, 'install.js'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"0.0.0"}');
  const payload = 'synthetic Windows binary fixture; never executed';
  const archive = path.join(dir, 'fixture.zip');
  const env = { ...process.env, POWERSHELL_TELEMETRY_OPTOUT:'1', POWERSHELL_UPDATECHECK:'Off',
    FIXTURE_ARCHIVE:archive, FIXTURE_PAYLOAD:payload };
  if (corrupt) fs.writeFileSync(archive, 'not a ZIP archive');
  else {
    // System.IO creates a real ZIP without relying on tar (the missing program
    // which triggers this fallback) or PowerShell's path/wildcard handling.
    const create = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      '$zip = [System.IO.Compression.ZipFile]::Open($env:FIXTURE_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Create); ' +
      '$entry = $zip.CreateEntry("ask-a-human.exe"); $writer = New-Object System.IO.StreamWriter($entry.Open()); ' +
      '$writer.Write($env:FIXTURE_PAYLOAD); $writer.Dispose(); $zip.Dispose()',
    ], { env, cwd:dir, encoding:'utf8', timeout:30000 });
    assert.ifError(create.error); assert.equal(create.status, 0, create.stderr);
  }
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const preload = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs'), os = require('node:os');
    const { EventEmitter } = require('node:events');
    const { Readable } = require('node:stream');
    const child = require('node:child_process');
    const execFileSync = child.execFileSync;
    // Only platform selection, HTTPS, and unavailable tar are simulated. The
    // downloaded bytes, checksum gate, filesystem, PowerShell, and ZIP are real.
    Object.defineProperty(process, 'platform', { value:'win32' });
    os.tmpdir = () => process.env.FIXTURE_TEMP;
    child.execFileSync = (name, args, options) => {
      if (name === 'tar') throw Object.assign(new Error('fixture: tar unavailable'), { code:'ENOENT' });
      if (name !== 'powershell') throw new Error('unexpected installer command');
      fs.writeFileSync(process.env.FIXTURE_FALLBACK, 'PowerShell fallback reached');
      return execFileSync(process.env.FIXTURE_POWERSHELL, args, options);
    };
    require('node:https').get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const asset = 'ask-a-human_windows_' + ({ x64:'amd64', arm64:'arm64' }[process.arch]) + '.zip';
        const bytes = url.endsWith('/checksums.txt')
          ? Buffer.from(process.env.FIXTURE_DIGEST + '  ' + asset + '\\n')
          : fs.readFileSync(process.env.FIXTURE_ARCHIVE);
        const response = Readable.from([bytes]); response.statusCode = 200; response.headers = {};
        callback(response);
      });
      return request;
    };
  `);
  Object.assign(env, { FIXTURE_TEMP:temp, FIXTURE_DIGEST:digest, FIXTURE_POWERSHELL:powershell,
    FIXTURE_FALLBACK:path.join(dir, 'fallback-reached'),
    AAH_BINARY_BASEURL:'https://mirror.example/dl',
    // Incoming variables must never override the verified archive/destination.
    AAH_INSTALL_ARCHIVE:'invalid inherited archive', AAH_INSTALL_DESTINATION:'invalid inherited destination' });
  delete env.AAH_SKIP_DOWNLOAD; delete env.AAH_BINARY_SHA256;
  const result = spawnSync(process.execPath, ['--require', preload, path.join(pkg, 'install.js')], {
    env, cwd:dir, encoding:'utf8', timeout:30000,
  });
  assert.ifError(result.error);
  assert.equal(fs.readFileSync(env.FIXTURE_FALLBACK, 'utf8'), 'PowerShell fallback reached');
  assert.deepEqual(fs.readdirSync(temp), [], 'temporary downloads removed after PowerShell exits');
  return { pkg, payload, result };
}

for (const [name, segment] of [
  ['ordinary paths', 'ordinary profile'],
  ['apostrophes', "O'Neil"],
  ['literal brackets', 'profile[1]'],
  ['combined PowerShell metacharacters', "O'Neil [1] $value `tick"],
]) {
  test(`PowerShell fallback installs with ${name}`, options, t => {
    const f = fixture(t, segment);
    assert.equal(f.result.status, 0, f.result.stdout + f.result.stderr);
    assert.equal(fs.readFileSync(path.join(f.pkg, 'bin/ask-a-human.exe'), 'utf8'), f.payload);
  });
}

test('PowerShell extraction failure propagates and removes temporary downloads', options, t => {
  const f = fixture(t, "O'Neil [1]", true);
  assert.equal(f.result.status, 1, f.result.stdout + f.result.stderr);
  assert.equal(fs.existsSync(path.join(f.pkg, 'bin/ask-a-human.exe')), false);
  assert.match(f.result.stdout, /sha256 verified/);
  assert.match(f.result.stderr, /download\/extract failed/);
});
