import type { ReactNode } from 'react';
export function RouteState(props: {
  state: 'loading' | 'empty' | 'not-found' | 'error';
  retry?: () => void;
}): ReactNode {
  return (
    <main>
      <h1 tabIndex={-1}>
        {props.state === 'loading'
          ? 'Loading'
          : props.state === 'empty'
            ? 'Nothing here yet'
            : props.state === 'not-found'
              ? 'Page not found'
              : 'Something went wrong'}
      </h1>
      <p role="status" aria-live="polite">
        {props.state === 'loading' ? 'Loading page.' : ''}
      </p>
      {props.state === 'error' && props.retry ? (
        <button
          type="button"
          onClick={() => {
            props.retry?.();
          }}
        >
          Try again
        </button>
      ) : null}
    </main>
  );
}
