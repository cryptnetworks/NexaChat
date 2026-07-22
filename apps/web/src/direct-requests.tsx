import type { ReactNode } from 'react';

export function DirectRequestControls(props: {
  requesterLabel: string;
  busy: boolean;
  onDecision: (decision: 'allow' | 'deny' | 'ignore' | 'block') => void;
}): ReactNode {
  return (
    <section aria-labelledby="direct-request-heading" aria-busy={props.busy}>
      <h2 id="direct-request-heading">Direct conversation request</h2>
      <p>{props.requesterLabel} would like to start a private conversation.</p>
      <div role="group" aria-label="Request actions">
        {(['allow', 'deny', 'ignore', 'block'] as const).map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={props.busy}
            onClick={() => {
              props.onDecision(decision);
            }}
          >
            {decision[0]?.toUpperCase()}
            {decision.slice(1)}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite">
        {props.busy ? 'Saving decision.' : ''}
      </p>
    </section>
  );
}
