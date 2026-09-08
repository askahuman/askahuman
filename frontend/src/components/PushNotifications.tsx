import type { Palette } from './theme.ts';
import type { PushStatus } from './usePushNotifications.ts';

export function PushNotifications({ c, push }: { c: Palette; push: PushStatus }) {
  let message: string;
  let action: { label: string; run: () => void } | undefined;
  if (push.permission === 'unsupported') {
    message = 'Notifications are unavailable here. On iPhone, open this app from your Home Screen.';
  } else if (push.permission === 'denied') {
    message = 'Notifications are blocked. Allow them in your browser or iPhone notification settings, then reopen this app.';
  } else if (push.permission === 'default') {
    message = 'Get a notification when an agent needs you.';
    action = { label: 'Enable notifications', run: push.enable };
  } else if (push.working) {
    message = 'Setting up notifications…';
  } else if (push.ready === push.total && push.total > 0) {
    message = `Notifications set up for ${push.total} ${push.total === 1 ? 'agent' : 'agents'}.`;
  } else if (push.failed) {
    message = `Notifications are not set up for ${push.total - push.ready} ${push.total - push.ready === 1 ? 'agent' : 'agents'}. Keep this app open for requests.`;
    action = { label: 'Retry notifications', run: push.retry };
  } else {
    message = 'Waiting for notification setup from your agent. If this continues, re-pair that agent. Keep this app open for requests.';
  }
  return (
    <div data-testid="push-status" style={{ flexShrink: 0, marginBottom: 18, textAlign: 'center', color: c.muted, fontSize: 12, lineHeight: 1.5 }}>
      <div role="status" aria-live="polite">{message}</div>
      {action && <button type="button" onClick={action.run} style={{ minHeight: 44, width: '100%', marginTop: 10, border: `1px solid ${c.approve}`, borderRadius: 10, background: c.approveDim, color: c.approve, font: 'inherit', cursor: 'pointer' }}>{action.label}</button>}
    </div>
  );
}
