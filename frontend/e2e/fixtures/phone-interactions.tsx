// Test-only entrypoint. The production Astro build never imports this fixture.
import { createRoot } from 'react-dom/client';

import { ChoiceScreen, ConfirmedScreen, ListeningScreen, OfflineScreen, TextScreen, YesNoScreen } from '../../src/components/screens.tsx';
import { dark } from '../../src/components/theme.ts';
import type { Request } from '../../src/lib/wire.ts';

const root = createRoot(document.getElementById('root')!);
let version = 0;
const test = {
  answers: [] as unknown[],
  render(kind: string, request: Request, confirmation: { label?: string; detail?: string; agent?: string } = {}) {
    this.answers = [];
    version++;
    const props = { c: dark, req: request, expiresIn: null };
    const record = (answer: unknown) => this.answers.push(answer);
    const screen = kind === 'yesno'
      ? <YesNoScreen {...props} onApprove={() => record(true)} onDecline={() => record(false)} />
      : kind === 'choice'
        ? <ChoiceScreen {...props} onChoose={record} />
        : kind === 'text'
          ? <TextScreen {...props} onSend={record} />
          : kind === 'confirmed'
            ? <ConfirmedScreen c={dark} icon="✓" label="Approved" approved detail="Decision received." agent="test agent" onDone={() => record('done')} {...confirmation} />
            : kind === 'offline'
              ? <OfflineScreen c={dark} attempt={1} onRetry={() => {}} />
              : <ListeningScreen c={dark} agent="test agent" roomID="test-room" />;
    root.render(<div key={version} data-render-version={version}>{screen}</div>);
    return version;
  },
};

(window as unknown as { phoneTest: typeof test }).phoneTest = test;
