import type { ReactNode } from 'react';

function HighlightedText(props: {
  text: string;
  ranges: readonly { start: number; end: number }[];
}): ReactNode {
  const output: ReactNode[] = [];
  let offset = 0;
  for (const [index, range] of props.ranges.entries()) {
    if (range.start < offset || range.end > props.text.length) continue;
    output.push(props.text.slice(offset, range.start));
    output.push(
      <mark key={index}>{props.text.slice(range.start, range.end)}</mark>,
    );
    offset = range.end;
  }
  output.push(props.text.slice(offset));
  return output;
}

export function MessageSearchResults(props: {
  status: 'loading' | 'ready' | 'error';
  results: readonly {
    id: string;
    label: string;
    excerpt: string;
    highlights: readonly { start: number; end: number }[];
    href: string;
  }[];
}): ReactNode {
  return (
    <section
      aria-labelledby="message-search-heading"
      aria-busy={props.status === 'loading'}
    >
      <h2 id="message-search-heading">Message search results</h2>
      <p role="status" aria-live="polite">
        {props.status === 'loading'
          ? 'Searching messages.'
          : props.status === 'error'
            ? 'Search is unavailable.'
            : `${String(props.results.length)} results.`}
      </p>
      <ol>
        {props.results.map((result) => (
          <li key={result.id}>
            <a href={result.href} aria-label={result.label}>
              <HighlightedText
                text={result.excerpt}
                ranges={result.highlights}
              />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
