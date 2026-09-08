import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const severities = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const advisoryID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Bun returns 1 both for findings and for a failed registry request. A usable
// report AND a consistent process status are required before applying policy.
export function evaluateAudit(stdout, status, exceptions = [], now = new Date()) {
  if (status !== 0 && status !== 1) throw new Error('scanner did not complete normally');
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error('scanner returned invalid or empty JSON'); }
  if (!isRecord(report)) throw new Error('scanner report must be a package-to-advisories object');
  if (!Array.isArray(exceptions)) throw new Error('exceptions must be an array');
  const allowed = new Set();
  for (const exception of exceptions) {
    if (!isRecord(exception) || !advisoryID.test(exception.id) ||
        typeof exception.reason !== 'string' || !exception.reason.trim() ||
        typeof exception.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) {
      throw new Error('invalid audit exception');
    }
    const expiry = new Date(exception.expires + 'T23:59:59.999Z');
    if (!Number.isFinite(expiry.valueOf()) || expiry.toISOString().slice(0, 10) !== exception.expires) {
      throw new Error('invalid exception expiry');
    }
    if (now > expiry) throw new Error('audit exception expired: ' + exception.id);
    if (allowed.has(exception.id)) throw new Error('duplicate audit exception: ' + exception.id);
    allowed.add(exception.id);
  }
  const findings = [], blocked = [], suppressed = [];
  for (const [pkg, advisories] of Object.entries(report)) {
    if (!pkg || !Array.isArray(advisories)) throw new Error('invalid advisory list for ' + pkg);
    for (const advisory of advisories) {
      if (!isRecord(advisory) || typeof advisory.title !== 'string' || !advisory.title.trim() ||
          !severities.has(advisory.severity) || typeof advisory.url !== 'string') {
        throw new Error('invalid advisory for ' + pkg);
      }
      let url;
      try { url = new URL(advisory.url); } catch { throw new Error('invalid advisory URL for ' + pkg); }
      if (url.protocol !== 'https:') throw new Error('invalid advisory URL scheme for ' + pkg);
      const finding = { package: pkg, ...advisory };
      findings.push(finding);
      if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
      const id = url.pathname.slice('/advisories/'.length);
      const exactAdvisory = url.origin === 'https://github.com' && !url.username && !url.password &&
        url.pathname === '/advisories/' + id && advisoryID.test(id) && !url.search && !url.hash;
      if (exactAdvisory && allowed.has(id)) suppressed.push(finding);
      else blocked.push(finding);
    }
  }
  if ((status === 0) !== (findings.length === 0)) {
    throw new Error('scanner status and unfiltered report disagree');
  }
  return { findings, blocked, suppressed };
}

function main() {
  try {
    const scan = spawnSync('bun', ['audit', '--json'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (scan.stderr) process.stderr.write(scan.stderr);
    if (scan.error || scan.signal) throw new Error('scanner failed: ' + (scan.error?.message || scan.signal));
    const exceptions = JSON.parse(readFileSync(new URL('../frontend/audit-exceptions.json', import.meta.url), 'utf8'));
    const result = evaluateAudit(scan.stdout, scan.status, exceptions);
    for (const item of result.findings) console.log(`${item.severity}: ${item.package}: ${item.title} (${item.url})`);
    console.log(`Validated audit: ${result.findings.length} records, ${result.suppressed.length} documented exceptions, ${result.blocked.length} blocking.`);
    if (result.blocked.length) throw new Error(result.blocked.length + ' unexcepted high/critical advisory records');
  } catch (error) {
    console.error('::error::dependency audit failed: ' + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
