import type { ReactNode } from 'react';
import { safeInternalHref } from './links.js';

export function DiscoveryResults(props: {
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  results: readonly {
    id: string;
    label: string;
    description: string;
    href: string;
  }[];
}): ReactNode {
  const listId = 'discovery-results';
  return (
    <section aria-labelledby="discovery-heading">
      <h2 id="discovery-heading">Discover members and spaces</h2>
      <label htmlFor="discovery-query">Search this community</label>
      <input
        id="discovery-query"
        type="search"
        minLength={2}
        maxLength={64}
        defaultValue={props.query}
        aria-controls={listId}
        aria-describedby="discovery-status"
        autoComplete="off"
      />
      <p id="discovery-status" role="status" aria-live="polite">
        {props.status === 'loading'
          ? 'Searching.'
          : props.status === 'error'
            ? 'Discovery is unavailable.'
            : props.status === 'ready'
              ? `${String(props.results.length)} results.`
              : 'Enter at least two characters.'}
      </p>
      <ul id={listId} aria-label="Discovery results">
        {props.results.map((result) => {
          const href = safeInternalHref(result.href);
          const content = (
            <>
              <strong>{result.label}</strong> <span>{result.description}</span>
            </>
          );
          return (
            <li key={result.id}>
              {href ? <a href={href}>{content}</a> : content}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
