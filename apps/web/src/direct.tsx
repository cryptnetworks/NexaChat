import type { FormEvent, ReactNode } from 'react';

export function DirectConversationPanel(props: {
  title: string;
  status: 'loading' | 'ready' | 'reconnecting' | 'error';
  messages: readonly {
    id: string;
    authorLabel: string;
    content: ReactNode;
    deleted: boolean;
  }[];
  onSend: (body: string) => void;
}): ReactNode {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = form.get('body');
    const body = typeof value === 'string' ? value.trim() : '';
    if (body) props.onSend(body);
  };
  return (
    <section aria-labelledby="direct-title">
      <h1 id="direct-title">{props.title}</h1>
      <p role="status" aria-live="polite">
        {props.status === 'reconnecting'
          ? 'Reconnecting. Messages may be delayed.'
          : props.status === 'error'
            ? 'Conversation unavailable.'
            : props.status === 'loading'
              ? 'Loading conversation.'
              : ''}
      </p>
      <ol aria-label="Direct messages">
        {props.messages.map((message) => (
          <li key={message.id}>
            <span className="visually-hidden">{message.authorLabel}: </span>
            {message.deleted ? <em>Message deleted</em> : message.content}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} aria-label="Send direct message">
        <label htmlFor="direct-message-body">Message</label>
        <textarea
          id="direct-message-body"
          name="body"
          maxLength={4000}
          required
        />
        <button type="submit">Send message</button>
      </form>
    </section>
  );
}
