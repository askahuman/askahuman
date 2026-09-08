import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { parse, visit } from 'jsonc-parser';

// GHSA-26w7-cxv4-gfx2 is fixed by Astro's Sharp dependency bump. This project
// already applies that exact dependency fix to Astro 5 through its override.
// Deliberately accept only the reviewed graph; dependency changes need review.
const VERSIONS = { astro: '5.18.2', sharp: '0.35.4', libvips: '1.3.3', vips: '8.18.6', heif: '1.23.2' };
const root = new URL('./', import.meta.url);
const fail = () => { throw new Error('image codec does not match the reviewed patched dependency graph'); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseLock(text) {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) fail();
  const errors = [], objects = [];
  let duplicate = false;
  visit(text, {
    onObjectBegin() { objects.push(new Set()); },
    onObjectProperty(key) {
      // jsonc-parser materializes ordinary objects; never admit prototype keys.
      if (key === '__proto__' || objects.at(-1).has(key)) duplicate = true;
      objects.at(-1).add(key);
    },
    onObjectEnd() { objects.pop(); },
    onError(error) { errors.push(error); },
  }, { allowTrailingComma: true });
  if (duplicate || errors.length) fail();
  return parse(text, errors, { allowTrailingComma: true });
}

export function verifyCodecGraph(lock) {
  if (!record(lock) || lock.lockfileVersion !== 1 || !record(lock.packages) ||
      lock.overrides?.sharp !== '^' + VERSIONS.sharp ||
      lock.packages.astro?.[0] !== 'astro@' + VERSIONS.astro ||
      lock.packages.sharp?.[0] !== 'sharp@' + VERSIONS.sharp) fail();
  const versions = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const specifier = Array.isArray(entry) ? entry[0] : '';
    const nested = !/^@[^/]+\/[^/]+$/.test(key) && /\/(?:astro|sharp)$/.test(key);
    const relevant = key === 'astro' || key === 'sharp' || nested || key.includes('@img/sharp-') ||
      typeof specifier === 'string' && /^(?:astro|sharp|@img\/sharp-[^@]+)@/.test(specifier);
    if (!relevant) continue;
    const match = typeof specifier === 'string' && /^(astro|sharp|@img\/sharp-[^@]+)@(\d+\.\d+\.\d+)$/.exec(specifier);
    if (!match || key !== match[1] || versions.has(key)) fail();
    const expected = key === 'astro' ? VERSIONS.astro : key.startsWith('@img/sharp-libvips-') ? VERSIONS.libvips : VERSIONS.sharp;
    if (match[2] !== expected || !record(entry[2])) fail();
    versions.set(key, match[2]);
  }
  const native = lock.packages.sharp[2]?.optionalDependencies;
  if (!record(native) || !Object.keys(native).length) fail();
  for (const [name, version] of Object.entries(native)) {
    if (!name.startsWith('@img/sharp-') || versions.get(name) !== version) fail();
  }
  for (const name of versions.keys()) {
    const info = lock.packages[name][2];
    for (const field of ['dependencies', 'optionalDependencies']) {
      if (info[field] === undefined) continue;
      if (!record(info[field])) fail();
      for (const [dependency, version] of Object.entries(info[field])) {
        if (dependency.startsWith('@img/sharp-') && versions.get(dependency) !== version) fail();
      }
    }
  }
  if (![...versions.keys()].some(name => name.startsWith('@img/sharp-libvips-'))) fail();
  return versions;
}

export function verifyNativeCodec({ astro, sharp, addon, vendor, embeddedVendor, loaded, runtime, versions, localAddon }) {
  if (astro !== VERSIONS.astro || sharp !== VERSIONS.sharp || addon !== VERSIONS.sharp ||
      typeof embeddedVendor !== 'boolean' || vendor !== (embeddedVendor ? VERSIONS.sharp : VERSIONS.libvips) ||
      loaded !== true || localAddon !== false ||
      !record(runtime) || runtime.isGlobal !== false || runtime.isWasm !== false ||
      runtime.semver !== VERSIONS.vips || !record(versions) ||
      versions.sharp !== VERSIONS.sharp || versions.vips !== runtime.semver ||
      versions.heif !== VERSIONS.heif) fail();
}

function packageAt(entry, expectedName) {
  let directory = dirname(fileURLToPath(entry));
  for (let depth = 0; depth < 4; depth++, directory = dirname(directory)) {
    const path = join(directory, 'package.json');
    if (!existsSync(path)) continue;
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    if (metadata.name === expectedName) return { directory, metadata };
  }
  fail();
}

export async function assertPatchedImageCodec() {
  const graph = verifyCodecGraph(parseLock(readFileSync(new URL('bun.lock', root), 'utf8')));
  const require = createRequire(new URL('package.json', root));
  const astroPath = require.resolve('astro/package.json');
  const astro = JSON.parse(readFileSync(astroPath, 'utf8'));
  // Resolve with ESM conditions from the same module that imports Sharp in Astro.
  const service = new URL('./dist/assets/services/sharp.js', pathToFileURL(astroPath));
  if (!existsSync(service)) fail();
  const sharpURL = resolve('sharp', service.href);
  const sharpPackage = packageAt(sharpURL, 'sharp');
  if (astro.version !== VERSIONS.astro || sharpPackage.metadata.version !== VERSIONS.sharp) fail();
  const fromSharp = createRequire(sharpURL);
  let platform = process.platform;
  if (platform === 'linux') {
    const libc = fromSharp('detect-libc').familySync();
    if (libc !== 'glibc' && libc !== 'musl') fail();
    if (libc === 'musl') platform += 'musl';
  }
  platform += '-' + process.arch;
  const localPaths = [platform, 'wasm32'].map(name =>
    join(sharpPackage.directory, 'src/build/Release', `sharp-${name}-${VERSIONS.sharp}.node`));
  // Local/global native replacements are not the vendor codec attested by this
  // exception. This is a build dependency check, not a tamper-proof runtime.
  const localExists = path => {
    try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (localPaths.some(localExists) || Object.keys(process.env).some(key =>
    /^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_)/.test(key) && process.env[key])) fail();
  const addonName = '@img/sharp-' + platform;
  // Windows ships its codec libraries/versions inside the native addon package.
  const embeddedVendor = process.platform === 'win32';
  const vendorName = embeddedVendor ? addonName : '@img/sharp-libvips-' + platform;
  const addonURL = resolve(addonName + '/sharp.node', sharpURL);
  const vendorURL = resolve(vendorName + '/versions', sharpURL);
  const addon = packageAt(addonURL, addonName);
  const vendor = packageAt(vendorURL, vendorName);
  if (graph.get(addonName) !== addon.metadata.version || graph.get(vendorName) !== vendor.metadata.version) fail();
  const imported = (await import(sharpURL)).default;
  const selected = Object.values(require.cache).filter(module =>
    module.filename?.endsWith('.node') && typeof module.exports?.libvipsVersion === 'function');
  // The package export is a CJS wrapper around this versioned native file.
  const expectedNative = join(addon.directory, 'lib', `sharp-${platform}-${VERSIONS.sharp}.node`);
  const loaded = selected.length === 1 && realpathSync(selected[0].filename) === realpathSync(expectedNative) &&
    selected[0].exports === fromSharp(addonName + '/sharp.node');
  verifyNativeCodec({
    astro: astro.version, sharp: sharpPackage.metadata.version,
    addon: addon.metadata.version, vendor: vendor.metadata.version, embeddedVendor,
    loaded, runtime: loaded ? selected[0].exports.libvipsVersion() : null,
    versions: imported?.versions, localAddon: false,
  });
  return true;
}
