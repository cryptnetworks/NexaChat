import { useState, type ReactNode } from 'react';
import type {
  CredentialInventory,
  CredentialStoreStatus,
  StoredDesktopAccount,
} from './desktop-credentials.js';

export function DesktopCredentialControls(props: {
  status: CredentialStoreStatus;
  inventory?: CredentialInventory;
  busy: boolean;
  message: string;
  onSelect: (account: StoredDesktopAccount) => void;
  onRemove: (account: StoredDesktopAccount) => void;
  onClear: () => void;
}): ReactNode {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const unavailable = props.status.state === 'unavailable';
  const recoveryRequired = props.status.state === 'recovery_required';

  return (
    <section aria-labelledby="saved-sign-ins-heading">
      <h2 id="saved-sign-ins-heading">Saved sign-ins</h2>
      <p id="credential-store-help">
        Session secrets are kept in your operating system credential store and
        are never displayed here.
      </p>
      {unavailable && (
        <p role="alert">
          Secure storage is unavailable. Nexa Chat will not fall back to a
          plain-text file.
        </p>
      )}
      {recoveryRequired && (
        <p role="alert">
          Saved sign-ins are damaged. Clear them from this device, then sign in
          again.
        </p>
      )}
      {props.status.state === 'available' && props.inventory && (
        <>
          {props.inventory.accounts.length === 0 ? (
            <p>No sign-ins are saved on this device.</p>
          ) : (
            <ul aria-describedby="credential-store-help">
              {props.inventory.accounts.map((account) => (
                <li key={`${account.serverOrigin}:${account.accountId}`}>
                  <strong>{account.accountLabel}</strong>{' '}
                  <span>{account.serverOrigin}</span>{' '}
                  {account.selected && <span>Selected</span>}
                  <button
                    type="button"
                    disabled={props.busy || account.selected}
                    aria-label={`Use saved sign-in for ${account.accountLabel} on ${account.serverOrigin}`}
                    onClick={() => {
                      props.onSelect(account);
                    }}
                  >
                    Use account
                  </button>
                  <button
                    type="button"
                    disabled={props.busy}
                    aria-label={`Remove saved sign-in for ${account.accountLabel} on ${account.serverOrigin}`}
                    onClick={() => {
                      props.onRemove(account);
                    }}
                  >
                    Remove from this device
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {(recoveryRequired || (props.inventory?.accounts.length ?? 0) > 0) &&
        (confirmingClear ? (
          <div role="group" aria-label="Confirm clearing saved sign-ins">
            <p>This removes every saved sign-in from this device.</p>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => {
                setConfirmingClear(false);
                props.onClear();
              }}
            >
              Confirm clear
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => {
                setConfirmingClear(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={props.busy || unavailable}
            onClick={() => {
              setConfirmingClear(true);
            }}
          >
            Clear saved sign-ins
          </button>
        ))}
      <p role="status" aria-live="polite">
        {props.message}
      </p>
    </section>
  );
}
