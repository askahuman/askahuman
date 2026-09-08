// Models the push service only. Registrations, activation, caches, app/session,
// WebSocket transport and persistence remain the real browser implementations.
// No request is sent to an external push service or notification recipient.
export function installPushServiceFixture() {
  const nativeNotification = window.Notification;
  const read = (key, fallback) => JSON.parse(localStorage.getItem(`push-fixture:${key}`) || JSON.stringify(fallback));
  const write = (key, value) => localStorage.setItem(`push-fixture:${key}`, JSON.stringify(value));
  const record = (event) => write('events', [...read('events', []), event]);
  Object.defineProperty(nativeNotification, 'permission', { configurable: true, get: () => read('permission', 'default') });
  nativeNotification.requestPermission = () => {
    record({ type: 'permission', gesture: navigator.userActivation.isActive });
    write('permission', 'granted');
    return Promise.resolve('granted');
  };
  Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
    configurable: true,
    get() {
      const scope = this.scope;
      const current = () => read('subscriptions', {})[scope] || null;
      const make = (value) => value && ({
        options: { applicationServerKey: new Uint8Array(value.key).buffer },
        toJSON: () => ({ endpoint: value.endpoint, keys: value.keys }),
        unsubscribe: async () => {
          record({ type: 'unsubscribe', scope, endpoint: value.endpoint });
          const subscriptions = read('subscriptions', {}); delete subscriptions[scope]; write('subscriptions', subscriptions);
          return true;
        },
      });
      return {
        getSubscription: async () => {
          if (read('fail', '') === scope) throw new Error('deterministic push service failure');
          return make(current());
        },
        subscribe: async ({ applicationServerKey }) => {
          if (current()) throw new DOMException('already subscribed', 'InvalidStateError');
          const key = [...new Uint8Array(applicationServerKey)];
          const sequence = read('sequence', 0) + 1; write('sequence', sequence);
          const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
          const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
          const b64url = (v) => btoa(String.fromCharCode(...v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const value = { key, endpoint: `https://fcm.googleapis.com/fcm/send/local-fixture-${sequence}`, keys: { p256dh: b64url(publicKey), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
          write('subscriptions', { ...read('subscriptions', {}), [scope]: value });
          record({ type: 'subscribe', scope, key, endpoint: value.endpoint });
          return make(value);
        },
      };
    },
  });
  if (read('unsupported', false)) delete window.PushManager;
}
