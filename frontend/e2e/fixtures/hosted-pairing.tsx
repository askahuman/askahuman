import { createRoot } from 'react-dom/client';
import { PairScreen } from '../../src/components/PairScreen.tsx';
import { dark } from '../../src/components/theme.ts';

declare global {
  interface Window { pairingSubmissions: { code: string; relay: string }[] }
}
window.pairingSubmissions = [];
createRoot(document.getElementById('root')!).render(
  <PairScreen c={dark} error={null} onSubmitCode={(code, relay) => window.pairingSubmissions.push({ code, relay })} />,
);
