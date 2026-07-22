import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WebNotificationControls } from './web-notification-controls.js';
import { requestWebNotificationOptIn } from './web-notifications.js';

describe('web notification client', () => {
  it('does not prompt on startup and reports unsupported environments', async () => {
    expect(
      await requestWebNotificationOptIn('default', () =>
        Promise.resolve('granted'),
      ),
    ).toBe('unsupported');
  });

  it('renders an explicit accessible opt-in control', () => {
    const markup = renderToStaticMarkup(
      <WebNotificationControls accountId="00000000-0000-4000-8000-000000000000" />,
    );
    expect(markup).toContain('Turn on notifications');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('no message text');
  });

  it('keeps push payload rendering generic and same-origin', async () => {
    const worker = await readFile(
      new URL('../public/service-worker.js', import.meta.url),
      'utf8',
    );
    expect(worker).toContain('Open NexaChat to view this update.');
    expect(worker).toContain("candidate.route === '/notifications'");
    expect(worker).not.toContain('payload.body');
  });
});
