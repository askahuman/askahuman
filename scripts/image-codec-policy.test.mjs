import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLock, verifyCodecGraph, verifyNativeCodec } from '../frontend/image-codec-policy.mjs';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const lockText = readFileSync(join(frontend, 'bun.lock'), 'utf8');
const lock = () => parseLock(lockText);
const codec = () => ({
  astro: '5.18.2', sharp: '0.35.4', addon: '0.35.4', vendor: '1.3.3', embeddedVendor: false,
  loaded: true, localAddon: false, runtime: { isGlobal: false, isWasm: false, semver: '8.18.6' },
  versions: { sharp: '0.35.4', vips: '8.18.6', heif: '1.23.2' },
});

test('the complete installed lock is accepted, including legitimate scoped Astro packages', () => {
  const graph = verifyCodecGraph(lock());
  assert.equal(graph.get('sharp'), '0.35.4');
  assert.equal(graph.get('@img/sharp-libvips-linuxmusl-x64'), '1.3.3');
  assert.equal(graph.get('@img/sharp-win32-x64'), '0.35.4');
  assert.equal(graph.has('@vite-pwa/astro'), false);
});

test('JSONC handles comments and trailing commas without changing string data', () => {
  const value = parseLock('{/* comment */ "literal": "text,} // comment", "items": [1,],}');
  assert.deepEqual(value, { literal: 'text,} // comment', items: [1] });
  for (const text of [
    '', '{', '{"x":NaN}', '{"x":1,"x":2}', '{"x":1,"\\u0078":2}',
    '{"__proto__":{"packages":{}}}', '{"nested":{"\\u005f_proto__":{}}}',
    '{"x":1} {"y":2}', 'x'.repeat(4 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseLock(text));
  assert.throws(() => verifyCodecGraph(parseLock('null')));
});

test('old, missing, aliased, nested, and inconsistent dependency records fail closed', () => {
  const mutations = [
    value => { value.overrides.sharp = '^0.35.3'; },
    value => { value.packages.sharp[0] = 'sharp@0.35.3'; },
    value => { delete value.packages.sharp; },
    value => { value.packages.astro[0] = 'astro@7.2.8'; },
    value => { value.packages.alias = ['sharp@0.35.3', '', {}]; },
    value => { value.packages['astro/sharp'] = ['sharp@0.35.4', '', {}]; },
    value => { value.packages['other/astro'] = ['astro@5.18.2', '', {}]; },
    value => { value.packages['@img/sharp-libvips-linux-x64'][0] = '@img/sharp-libvips-linux-x64@1.3.2'; },
    value => { delete value.packages['@img/sharp-libvips-linuxmusl-x64']; },
    value => { value.packages.sharp[2].dependencies = 'invalid'; },
    value => { value.packages.sharp[2].optionalDependencies = null; },
    value => { value.packages.sharp[2].optionalDependencies = {}; },
    value => { value.packages.sharp[2].dependencies['@img/sharp-linux-x64'] = '0.35.3'; },
    value => { value.packages['@img/sharp-win32-x64'][2] = null; },
  ];
  for (const mutate of mutations) {
    const value = lock(); mutate(value);
    assert.throws(() => verifyCodecGraph(value));
  }
});

test('native evidence requires matching actual runtime, vendor codec, and packaged addon', () => {
  verifyNativeCodec(codec());
  verifyNativeCodec({ ...codec(), vendor: '0.35.4', embeddedVendor: true });
  const mutations = [
    value => { value.sharp = '0.35.3'; }, value => { value.addon = '0.35.3'; },
    value => { value.vendor = '1.3.2'; }, value => { value.embeddedVendor = true; },
    value => { delete value.embeddedVendor; }, value => { value.loaded = false; },
    value => { value.localAddon = true; }, value => { value.runtime.isGlobal = true; },
    value => { value.runtime.isWasm = true; }, value => { value.runtime.semver = '8.18.5'; },
    value => { delete value.versions.heif; }, value => { value.versions.heif = '1.23.1'; },
    value => { value.versions.vips = '8.18.5'; }, value => { value.versions.sharp = '0.35.3'; },
  ];
  for (const mutate of mutations) {
    const value = codec(); mutate(value);
    assert.throws(() => verifyNativeCodec(value));
  }
});

test('real service resolution, config/build entry points, and audit cannot hide stale evidence', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'image-codec # % '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = join(scratch, 'frontend'), scripts = join(scratch, 'scripts');
  mkdirSync(fixture); mkdirSync(scripts);
  for (const name of ['image-codec-policy.mjs', 'package.json', 'bun.lock', 'astro.config.mjs', 'audit-exceptions.json']) {
    cpSync(join(frontend, name), join(fixture, name));
  }
  cpSync(new URL('./audit-dependencies.mjs', import.meta.url), join(scripts, 'audit-dependencies.mjs'));
  const modules = join(fixture, 'node_modules'); mkdirSync(modules);
  for (const name of ['jsonc-parser', 'import-meta-resolve', 'sharp', '@img', 'detect-libc', 'semver']) {
    symlinkSync(realpathSync(join(frontend, 'node_modules', name)), join(modules, name), 'dir');
  }
  const astro = join(modules, 'astro'), service = join(astro, 'dist/assets/services');
  mkdirSync(service, { recursive: true });
  cpSync(join(frontend, 'node_modules/astro/package.json'), join(astro, 'package.json'));
  cpSync(join(frontend, 'node_modules/astro/dist/assets/services/sharp.js'), join(service, 'sharp.js'));
  const guardCode = `import { assertPatchedImageCodec } from ${JSON.stringify(pathToFileURL(join(fixture, 'image-codec-policy.mjs')).href)}; await assertPatchedImageCodec();`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LD_|DYLD_)/.test(key)) delete env[key];
  const run = (label, command, args, good, options = {}) => {
    const result = spawnSync(command, args, { cwd: fixture, encoding: 'utf8', timeout: 30_000, env, ...options });
    assert.equal(Boolean(result.error), false, label + ': process completed');
    assert.equal(result.status === 0, good, label + ': ' + result.stderr);
    if (!good) assert.match(result.stderr, /reviewed patched dependency graph/);
    return result;
  };
  const guard = (label, good) => run(label, process.execPath, ['--input-type=module', '-e', guardCode], good);
  guard('actual native addon with encoded checkout path', true);
  run('actual Bun config runtime', 'bun', ['--eval', guardCode], true);
  const nested = join(service, 'node_modules/sharp'); mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.3', type: 'module', exports: './index.js' }));
  writeFileSync(join(nested, 'index.js'), 'throw new Error("stale module must never be evaluated");');
  guard('service-local stale dependency despite patched root', false);
  rmSync(join(service, 'node_modules'), { recursive: true });
  guard('restored service resolution', true);

  // Use a private Sharp copy to test local fallback rejection without modifying
  // the installed dependency used by any other test or checkout.
  rmSync(join(modules, 'sharp'));
  cpSync(join(frontend, 'node_modules/sharp'), join(modules, 'sharp'), { recursive: true, dereference: true });
  const local = join(modules, 'sharp/src/build/Release'); mkdirSync(local, { recursive: true });
  const candidate = join(local, 'sharp-wasm32-0.35.4.node');
  symlinkSync(join(scratch, 'absent.node'), candidate);
  guard('even a dangling local fallback is unsupported', false);
  rmSync(candidate);
  guard('packaged addon after local fallback removal', true);

  writeFileSync(join(fixture, 'bun.lock'), lockText.replace('"sharp@0.35.4"', '"sharp@0.35.3"'));
  guard('patched installed native module cannot hide stale lock', false);
  run('config enforces the prerequisite before integration imports', process.execPath, [join(fixture, 'astro.config.mjs')], false);
  // Vite itself does not support '#' in its project root. Keep the independent
  // URL-resolution case above; exercise the actual CLI in its supported layout.
  const buildFixture = mkdtempSync(join(tmpdir(), 'image-codec-build-'));
  t.after(() => rmSync(buildFixture, { recursive: true, force: true }));
  cpSync(fixture, buildFixture, { recursive: true });
  run('actual Astro build enforces the same prerequisite', process.execPath,
    [join(frontend, 'node_modules/astro/astro.js'), 'build', '--root', buildFixture], false, { cwd: buildFixture });
  const bin = join(scratch, 'bin'); mkdirSync(bin);
  const report = JSON.stringify({ astro: [{ severity: 'critical', title: 'Codec advisory', url: 'https://github.com/advisories/GHSA-26w7-cxv4-gfx2' }] });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' \'' + report + '\'\nexit 1\n', { mode: 0o700 });
  run('actual audit refuses an exception without fresh codec evidence', process.execPath,
    [join(scripts, 'audit-dependencies.mjs')], false, { env: { ...env, PATH: bin } });
  writeFileSync(join(fixture, 'bun.lock'), lockText);
  rmSync(join(service, 'sharp.js'));
  guard('missing actual Astro image service', false);
});
