import { useState } from 'react';
import {
  disableWebNotifications,
  enableWebNotifications,
} from './web-notifications.js';

export function WebNotificationControls({ accountId }: { accountId: string }) {
  const [subscriptionId, setSubscriptionId] = useState<string>();
  const [status, setStatus] = useState('Web notifications are off.');
  const [busy, setBusy] = useState(false);

  async function enable() {
    setBusy(true);
    try {
      const result = await enableWebNotifications(accountId);
      if (result.status === 'enabled') {
        setSubscriptionId(result.subscriptionId);
        setStatus('Web notifications are enabled.');
      } else if (result.status === 'denied') {
        setStatus('Notifications are blocked in browser settings.');
      } else if (result.status === 'unsupported') {
        setStatus('This browser does not support web notifications.');
      } else setStatus('Web notifications are temporarily unavailable.');
    } catch {
      setStatus('Web notifications could not be enabled. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!subscriptionId) return;
    setBusy(true);
    const disabled = await disableWebNotifications(accountId, subscriptionId);
    setStatus(
      disabled
        ? 'Web notifications are off.'
        : 'Web notifications could not be disabled. Try again.',
    );
    if (disabled) setSubscriptionId(undefined);
    setBusy(false);
  }

  return (
    <section aria-labelledby="web-notification-heading">
      <h2 id="web-notification-heading">Web notifications</h2>
      <p id="web-notification-description">
        Notifications contain no message text or private community details.
      </p>
      <button
        type="button"
        aria-describedby="web-notification-description"
        disabled={busy}
        onClick={() => void (subscriptionId ? disable() : enable())}
      >
        {busy
          ? 'Updating…'
          : subscriptionId
            ? 'Turn off notifications'
            : 'Turn on notifications'}
      </button>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
