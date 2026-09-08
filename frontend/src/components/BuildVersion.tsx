import { BUILD } from '../lib/build.ts';
import type { Palette } from './theme.ts';

/** Baked bundle identity; deployment details are deliberately fetched separately. */
export function BuildVersion({ c }: { c: Palette }) {
  return (
    <div data-testid="build-version" style={{ marginTop: 10, flexShrink: 0, textAlign: 'center', color: c.muted, fontSize: 10 }}>
      app {BUILD.version} · {BUILD.commit.slice(0, 7)}{' · '}
      <a href="/version.json" target="_blank" rel="noopener noreferrer" style={{ color: c.muted }}>deployment details</a>
    </div>
  );
}
