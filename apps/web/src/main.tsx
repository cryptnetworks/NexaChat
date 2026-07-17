import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RealtimeEnvelope } from '@nexa/realtime-contracts';
import './styles.css';

type Entity = { id: string; name?: string; displayName?: string };
type Message = RealtimeEnvelope['payload']['message'];

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Request failed (${String(response.status)})`);
  return response.json() as Promise<T>;
}

function App() {
  const [account, setAccount] = useState<Entity>();
  const [community, setCommunity] = useState<Entity>();
  const [space, setSpace] = useState<Entity>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');

  async function begin() {
    try {
      setError('');
      const nextAccount = await post<Entity>('/v1/dev/accounts', {
        displayName: 'Local Explorer',
      });
      const nextCommunity = await post<Entity>('/v1/communities', {
        ownerId: nextAccount.id,
        name: 'Field Notes',
      });
      const nextSpace = await post<Entity>(
        `/v1/communities/${nextCommunity.id}/spaces`,
        { actorId: nextAccount.id, name: 'trailhead' },
      );
      setAccount(nextAccount);
      setCommunity(nextCommunity);
      setSpace(nextSpace);
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${protocol}://${location.host}/v1/realtime?spaceId=${nextSpace.id}`,
      );
      socket.onmessage = (event) => {
        const envelope = JSON.parse(String(event.data)) as RealtimeEnvelope;
        setMessages((current) => [...current, envelope.payload.message]);
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to start');
    }
  }

  async function send(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const data = new FormData(form.currentTarget);
    if (!account || !space) return;
    await post(`/v1/spaces/${space.id}/messages`, {
      authorId: account.id,
      body: data.get('message'),
    });
    form.currentTarget.reset();
  }

  return (
    <main>
      <aside>
        <div className="mark" aria-hidden="true">
          N
        </div>
        <p className="eyebrow">Community</p>
        <h1>{community?.name ?? 'Nexa Chat'}</h1>
        <p className="muted">A calm place for shared work.</p>
        {space && (
          <nav aria-label="Spaces">
            <span className="space">⌁ {space.name}</span>
          </nav>
        )}
      </aside>
      <section className="conversation">
        <header>
          <div>
            <p className="eyebrow">Text space</p>
            <h2>{space?.name ?? 'Welcome'}</h2>
          </div>
          <span className="status">Local development</span>
        </header>
        {!space ? (
          <div className="welcome">
            <span className="orb">✦</span>
            <h2>Start a small community</h2>
            <p>
              This guided development flow creates a local identity, community,
              and text space.
            </p>
            <button onClick={() => void begin()}>Create the demo space</button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="messages" aria-live="polite">
              {messages.length === 0 && (
                <p className="empty">
                  This space is ready. Write the first note.
                </p>
              )}
              {messages.map((message) => (
                <article key={message.id}>
                  <span className="avatar">LE</span>
                  <div>
                    <strong>Local Explorer</strong>
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                    <p>{message.body}</p>
                  </div>
                </article>
              ))}
            </div>
            <form onSubmit={(event) => void send(event)}>
              <label className="sr-only" htmlFor="message">
                Message
              </label>
              <input
                id="message"
                name="message"
                maxLength={4000}
                required
                placeholder={`Write in ${space.name ?? 'space'}`}
              />
              <button>Send</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
