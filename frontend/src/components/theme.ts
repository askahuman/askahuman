// theme mirrors renderVals().c from the design mockup (frontend/initial-design)
// so the React islands reproduce the exact inline-style palette. Dark is the
// default; light follows prefers-color-scheme. Tokens are also in global.css
// for the Astro shell; this object is for inline styles inside React.

export interface Palette {
  page: string;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderSoft: string;
  text: string;
  muted: string;
  faint: string;
  approve: string;
  decline: string;
  approveDim: string;
  declineDim: string;
  glass: string;
}

export const dark: Palette = {
  page: '#08090c',
  bg: '#0c0d11',
  surface: '#15171d',
  surface2: '#1b1e26',
  border: '#2a2e38',
  borderSoft: '#21242c',
  text: '#e9ebf0',
  muted: '#8b919d',
  faint: '#5b616c',
  approve: '#39d98a',
  decline: '#ff5d52',
  approveDim: 'rgba(57,217,138,0.14)',
  declineDim: 'rgba(255,93,82,0.14)',
  glass: 'rgba(24,27,34,0.72)',
};

export const light: Palette = {
  page: '#dfe2e7',
  bg: '#f4f5f8',
  surface: '#ffffff',
  surface2: '#f0f2f6',
  border: '#dde0e6',
  borderSoft: '#e8eaef',
  text: '#15171c',
  muted: '#5e6470',
  faint: '#9aa0ab',
  approve: '#11a861',
  decline: '#e23b30',
  approveDim: 'rgba(17,168,97,0.12)',
  declineDim: 'rgba(226,59,48,0.10)',
  glass: 'rgba(255,255,255,0.72)',
};

/** Category badge palette (shared dark/light), from renderVals().cat. */
export const categoryColor: Record<string, string> = {
  cash: '#2dd4bf',
  deploy: '#f5a524',
  data: '#5b9cf6',
  access: '#c084fc',
  other: '#94a3b8',
};

/** catColor returns the dot color for a (possibly unknown) category. */
export function catColor(category: string | undefined): string {
  if (!category) return categoryColor.other!;
  return categoryColor[category] ?? categoryColor.other!;
}

/** pad2 zero-pads a number to two digits (countdown mm:ss). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** countdown formats remaining seconds as mm:ss (clamped at 0). */
export function countdown(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
