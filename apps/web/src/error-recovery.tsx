import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface SafeClientError {
  code: string;
  correlationId: string | null;
  recoverable: boolean;
}
export function safeClientError(error: unknown): SafeClientError {
  const candidate =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  return {
    code:
      typeof candidate.code === 'string' &&
      /^[a-z0-9_]{2,64}$/.test(candidate.code)
        ? candidate.code
        : 'unexpected_error',
    correlationId:
      typeof candidate.correlationId === 'string' &&
      /^[A-Za-z0-9-]{8,128}$/.test(candidate.correlationId)
        ? candidate.correlationId
        : null,
    recoverable: candidate.recoverable !== false,
  };
}

export class GlobalErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: SafeClientError | null }
> {
  override state: { error: SafeClientError | null } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: SafeClientError } {
    return { error: safeClientError(error) };
  }
  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    void _error;
    void _info;
    // Telemetry receives only code/correlation from state; component stacks,
    // route parameters, drafts, message bodies, and browser storage are omitted.
  }
  override render(): ReactNode {
    const error = this.state.error;
    if (!error) return this.props.children;
    return (
      <main>
        <h1 tabIndex={-1}>
          {error.recoverable
            ? 'This page can be recovered'
            : 'The application cannot continue'}
        </h1>
        <p role="alert">Your unsent text is still saved on this device.</p>
        {error.correlationId ? (
          <p>
            Reference: <code>{error.correlationId}</code>
          </p>
        ) : null}
        {error.recoverable ? (
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            Try again
          </button>
        ) : (
          <a href="/">Return home</a>
        )}
      </main>
    );
  }
}
