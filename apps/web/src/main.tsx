import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  websocketServerMessageSchema,
  type AccountResponse,
  type CommunityResponse,
  type CategoryResponse,
  type SpaceResponse,
} from '@nexa/api-contracts';
import {
  realtimeEnvelopeSchema,
  type RealtimeEnvelope,
} from '@nexa/realtime-contracts';
import './styles.css';

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

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`Request failed (${String(response.status)})`);
  return response.json() as Promise<T>;
}

function App() {
  const [account, setAccount] = useState<AccountResponse>();
  const [community, setCommunity] = useState<CommunityResponse>();
  const [space, setSpace] = useState<SpaceResponse>();
  const [categories, setCategories] = useState<CategoryResponse[]>([]);
  const [spaces, setSpaces] = useState<SpaceResponse[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!account || !space) return;
    let active = true;
    setLoadingHistory(true);
    setError('');
    void get<{ items: Message[] }>(
      `/v1/spaces/${space.id}/messages?actorId=${encodeURIComponent(account.id)}`,
    )
      .then((page) => {
        if (active) setMessages(page.items);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : 'Unable to load history',
          );
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => {
      active = false;
    };
  }, [account, space]);

  async function begin() {
    try {
      setLoading(true);
      setError('');
      const nextAccount = await post<AccountResponse>('/v1/dev/accounts', {
        displayName: 'Local Explorer',
      });
      const nextCommunity = await post<CommunityResponse>('/v1/communities', {
        ownerId: nextAccount.id,
        name: 'Field Notes',
      });
      const category = await post<CategoryResponse>(
        `/v1/communities/${nextCommunity.id}/categories`,
        { actorId: nextAccount.id, name: 'General' },
      );
      const nextSpace = await post<SpaceResponse>(
        `/v1/communities/${nextCommunity.id}/spaces`,
        {
          actorId: nextAccount.id,
          name: 'trailhead',
          categoryId: category.id,
        },
      );
      setAccount(nextAccount);
      setCommunity(nextCommunity);
      setSpace(nextSpace);
      setCategories([category]);
      setSpaces([nextSpace]);
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${protocol}://${location.host}/v1/realtime`,
      );
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            spaceId: nextSpace.id,
            actorId: nextAccount.id,
          }),
        );
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          setError('Realtime server returned an invalid message');
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          setError('Realtime server returned an invalid message');
          return;
        }
        const envelope = realtimeEnvelopeSchema.safeParse(raw);
        if (envelope.success) {
          setMessages((current) => {
            const message = envelope.data.payload.message;
            const withoutCurrent = current.filter(
              (item) => item.id !== message.id,
            );
            return [...withoutCurrent, message].sort(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id),
            );
          });
          return;
        }
        const control = websocketServerMessageSchema.safeParse(raw);
        if (control.success && control.data.type === 'error')
          setError(`Realtime connection rejected (${control.data.error})`);
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to start');
    } finally {
      setLoading(false);
    }
  }

  async function send(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const data = new FormData(form.currentTarget);
    if (!account || !space) return;
    await post(`/v1/spaces/${space.id}/messages`, {
      authorId: account.id,
      body: data.get('message'),
      idempotencyKey: crypto.randomUUID(),
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
        {community && (
          <nav aria-label="Community navigation">
            {categories.length === 0 && (
              <p className="empty">No categories yet.</p>
            )}
            {categories.map((category) => (
              <section
                key={category.id}
                aria-labelledby={`category-${category.id}`}
              >
                <h2 id={`category-${category.id}`}>{category.name}</h2>
                {spaces
                  .filter((item) => item.categoryId === category.id)
                  .map((item) => (
                    <button
                      key={item.id}
                      className="space"
                      aria-current={item.id === space?.id ? 'page' : undefined}
                      onClick={() => {
                        setSpace(item);
                      }}
                    >
                      ⌁ {item.name}
                    </button>
                  ))}
              </section>
            ))}
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
            <button
              onClick={() => void begin()}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Creating…' : 'Create the demo space'}
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="messages" aria-live="polite">
              {loadingHistory && <p className="empty">Loading history…</p>}
              {!loadingHistory && messages.length === 0 && (
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
                    {message.replyToId && (
                      <p className="muted">Reply to an earlier message</p>
                    )}
                    <p>
                      {message.deletedAt ? (
                        <span aria-label="Deleted message">
                          Message deleted
                        </span>
                      ) : (
                        message.body
                      )}
                    </p>
                    {!message.deletedAt &&
                      message.updatedAt !== message.createdAt && (
                        <span className="muted" aria-label="Edited message">
                          Edited
                        </span>
                      )}
                  </div>
                </article>
              ))}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
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
                placeholder={`Write in ${space.name}`}
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
