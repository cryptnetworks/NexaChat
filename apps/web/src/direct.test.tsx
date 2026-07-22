import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DirectConversationPanel } from './direct.js';

describe('direct conversation accessibility', () => {
  it('labels history and composer and announces reconnect state without exposing content', () => {
    const markup = renderToStaticMarkup(
      <DirectConversationPanel
        title="Direct conversation"
        status="reconnecting"
        messages={[
          { id: '1', authorLabel: 'Account', content: 'secret', deleted: true },
        ]}
        onSend={() => {}}
      />,
    );
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Direct messages"');
    expect(markup).toContain('for="direct-message-body"');
    expect(markup).toContain('Message deleted');
    expect(markup).not.toContain('secret');
  });
});
