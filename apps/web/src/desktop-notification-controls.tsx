import { useEffect, useMemo, useState } from 'react';
import {
  createDesktopNotificationClient,
  desktopNotificationPreferenceEvent,
  initializeDesktopNotifications,
  loadDesktopNotificationPreference,
  saveDesktopNotificationPreference,
  type DesktopNotificationClient,
  type DesktopNotificationPermission,
  type DesktopNotificationPreference,
} from './desktop-notifications.js';

export function DesktopNotificationControls({
  accountId,
  clientOverride,
  storageOverride,
}: {
  accountId: string;
  clientOverride?: DesktopNotificationClient;
  storageOverride?: Pick<Storage, 'getItem' | 'setItem'>;
}) {
  const storage = storageOverride ?? localStorage;
  const client = useMemo(
    () => clientOverride ?? createDesktopNotificationClient(),
    [clientOverride],
  );
  const [preference, setPreference] = useState<DesktopNotificationPreference>(
    () => loadDesktopNotificationPreference(storage, accountId),
  );
  const [permission, setPermission] =
    useState<DesktopNotificationPermission>('unavailable');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const synchronize = () => {
      setPreference(loadDesktopNotificationPreference(storage, accountId));
    };
    synchronize();
    window.addEventListener('storage', synchronize);
    window.addEventListener(desktopNotificationPreferenceEvent, synchronize);
    return () => {
      window.removeEventListener('storage', synchronize);
      window.removeEventListener(
        desktopNotificationPreferenceEvent,
        synchronize,
      );
    };
  }, [accountId, storage]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const refresh = () =>
      void client
        .status()
        .then((status) => {
          if (active) setPermission(status.permission);
        })
        .catch(() => {
          if (active) setPermission('unavailable');
        });
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      active = false;
    };
  }, [client]);

  if (!client) return null;
  const activeClient = client;

  async function enable() {
    setBusy(true);
    setMessage('');
    try {
      const status = await activeClient.requestPermission();
      setPermission(status.permission);
      if (status.permission !== 'granted') {
        setMessage(
          status.permission === 'denied'
            ? 'Notifications are blocked in system settings.'
            : 'Notification permission was not granted.',
        );
        return;
      }
      const next = await initializeDesktopNotifications({
        accountId,
        client: activeClient,
        storage,
      });
      setPreference(next);
      setMessage('Desktop notifications are enabled for new activity.');
    } catch {
      setMessage('Desktop notifications could not be enabled. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function update(next: DesktopNotificationPreference, announcement: string) {
    try {
      saveDesktopNotificationPreference(storage, accountId, next);
      setPreference(next);
      setMessage(announcement);
    } catch {
      setMessage('The notification setting could not be saved.');
    }
  }

  return (
    <section aria-labelledby="desktop-notification-heading">
      <h3 id="desktop-notification-heading">Desktop notifications</h3>
      <p id="desktop-notification-description">
        Delivery follows your server notification preferences. Privacy mode
        hides the update type on the lock screen.
      </p>
      <button
        type="button"
        aria-describedby="desktop-notification-description"
        disabled={busy}
        onClick={() => {
          if (preference.enabled) {
            update(
              { ...preference, enabled: false },
              'Desktop notifications are off.',
            );
          } else void enable();
        }}
      >
        {busy
          ? 'Updating…'
          : preference.enabled
            ? 'Turn off desktop notifications'
            : 'Turn on desktop notifications'}
      </button>
      <label>
        <input
          type="checkbox"
          checked={preference.privacyMode}
          disabled={busy}
          onChange={(event) => {
            update(
              { ...preference, privacyMode: event.currentTarget.checked },
              event.currentTarget.checked
                ? 'Notification privacy mode is on.'
                : 'Notification privacy mode is off.',
            );
          }}
        />{' '}
        Hide update types in system notifications
      </label>
      {permission === 'denied' && (
        <p role="alert">
          Allow notifications in system settings to enable delivery.
        </p>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
