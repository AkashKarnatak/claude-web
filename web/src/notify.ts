// Attention signals for permission requests arriving while the tab is not
// focused. Browsers forbid a background tab from focusing itself, so we use
// the sanctioned path: a system notification whose click handler may call
// window.focus(), plus a title-bar indicator.

let current: Notification | null = null;

/** Call from a user gesture (e.g. sending a prompt) so the browser allows it. */
export function ensureNotifyPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

export function notifyPermissionRequest(tool: string, detail: string): void {
  if (document.hasFocus()) return; // user is already looking at us
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  current?.close();
  current = new Notification('Claude needs permission', {
    body: `${tool}: ${detail}`.slice(0, 120),
    tag: 'claude-web-permission', // replaces rather than stacks
    requireInteraction: true, // stays on screen until addressed (where supported)
  });
  current.onclick = () => {
    window.focus();
    current?.close();
    current = null;
  };
}

export function clearPermissionNotification(): void {
  current?.close();
  current = null;
}
