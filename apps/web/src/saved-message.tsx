import type { ReactNode } from 'react';
export function SavedMessageButton(props: {
  saved: boolean;
  busy: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.saved}
      disabled={props.busy}
      onClick={() => {
        props.onToggle();
      }}
    >
      {props.saved ? 'Remove from saved messages' : 'Save message'}
    </button>
  );
}
