import { pushOpenURL, roomFromPushMessage } from './push-routing.ts';

let installed = false;
let selectRoom: ((room: string) => void) | undefined;

// This small receiver loads independently of React and its crypto dependencies.
// A wake during App hydration is retained in the fragment before acknowledging;
// once App is ready, selection happens directly without navigation or a reload.
export function installPushReceiver(): void {
  if (installed || !navigator.serviceWorker) return;
  installed = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const room = roomFromPushMessage(event, window.location.origin);
    if (!room) return;
    try {
      if (selectRoom) selectRoom(room);
      else history.replaceState(history.state, '', pushOpenURL(room));
      event.ports[0]?.postMessage({ type: 'aah:push-opened', room });
    } catch { /* Without acknowledgement the worker can open the durable URL. */ }
    finally { event.ports[0]?.close(); }
  });
}

export function onPushRoom(select: (room: string) => void): () => void {
  installPushReceiver();
  selectRoom = select;
  return () => { if (selectRoom === select) selectRoom = undefined; };
}
