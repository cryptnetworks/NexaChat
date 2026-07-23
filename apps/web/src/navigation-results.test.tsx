import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiscoveryResults } from './discovery.js';
import { MessageSearchResults } from './search.js';

describe('result navigation safety', () => {
  it('keeps unsafe discovery and search targets inert', () => {
    const discovery = renderToStaticMarkup(
      <DiscoveryResults
        query="test"
        status="ready"
        results={[
          {
            id: 'one',
            label: 'Unsafe result',
            description: 'Description',
            href: 'javascript:alert(1)',
          },
        ]}
      />,
    );
    const search = renderToStaticMarkup(
      <MessageSearchResults
        status="ready"
        results={[
          {
            id: 'two',
            label: 'Safe result',
            excerpt: 'Message',
            highlights: [],
            href: '/spaces/two#message',
          },
        ]}
      />,
    );

    expect(discovery).toContain('Unsafe result');
    expect(discovery).not.toContain('<a');
    expect(discovery).not.toContain('javascript:');
    expect(search).toContain('href="/spaces/two#message"');
  });
});
