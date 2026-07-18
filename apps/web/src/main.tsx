import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  websocketServerMessageSchema,
  type AccountResponse,
  type CommunityResponse,
  type CategoryResponse,
  type SpaceResponse,
  type CreatedInvitationResponse,
  type InvitationPreviewResponse,
} from '@nexa/api-contracts';
import {
  realtimeDeliverySchema,
  realtimeEnvelopeSchema,
  type RealtimeEnvelope,
} from '@nexa/realtime-contracts';
import './styles.css';
import { acceptDelivery, reconnectDelay } from './realtime.js';
import { invitationTokenFromHash } from './invitations.js';

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
  const [inviteToken] = useState(() => invitationTokenFromHash(location.hash));
  const [invitePreview, setInvitePreview] =
    useState<InvitationPreviewResponse>();
  const [createdInvite, setCreatedInvite] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');
  const realtimeCursor = useRef({
    sequence: 0,
    seenEventIds: new Set<string>(),
  });

  useEffect(() => {
    if (inviteToken)
      history.replaceState(null, '', `${location.pathname}${location.search}`);
  }, [inviteToken]);

  useEffect(() => {
    if (!inviteToken || !account) return;
    setInviteStatus('Checking invitation…');
    void post<InvitationPreviewResponse>('/v1/invitations/preview', {
      actorId: account.id,
      token: inviteToken,
    })
      .then((preview) => {
        setInvitePreview(preview);
        setInviteStatus('');
      })
      .catch(() => {
        setInviteStatus('This invitation is invalid or no longer available.');
      });
  }, [account, inviteToken]);

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

  useEffect(() => {
    if (!account || !space) return;
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const reconcile = async () => {
      const page = await get<{ items: Message[] }>(
        `/v1/spaces/${space.id}/messages?actorId=${encodeURIComponent(account.id)}`,
      );
      if (active) setMessages(page.items);
    };

    const connect = () => {
      if (!active) return;
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/v1/realtime`);
      socket.onopen = () => {
        attempts = 0;
        socket?.send(
          JSON.stringify({
            version: 1,
            type: 'subscribe',
            requestId: crypto.randomUUID(),
            spaceId: space.id,
          }),
        );
        void reconcile().catch(() => {
          setError('Unable to reconcile history');
        });
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          setError('Realtime server returned an invalid message');
          return;
        }
        const delivery = realtimeDeliverySchema.safeParse(raw);
        if (delivery.success) {
          const next = delivery.data;
          const accepted = acceptDelivery(
            realtimeCursor.current,
            next.event.id,
            next.sequence,
          );
          if (!accepted.accepted) return;
          if (accepted.gap)
            void reconcile().catch(() => {
              setError('Unable to recover missed messages');
            });
          const envelope = realtimeEnvelopeSchema.parse(next.event);
          setMessages((current) => {
            const message = envelope.payload.message;
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
      socket.onclose = (event) => {
        if (!active || event.code === 1000 || event.code === 1001) return;
        attempts += 1;
        if (attempts > 8) {
          setError('Realtime connection could not be restored');
          return;
        }
        reconnectTimer = window.setTimeout(connect, reconnectDelay(attempts));
      };
    };

    realtimeCursor.current.sequence = 0;
    realtimeCursor.current.seenEventIds.clear();
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, 'space changed');
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

  async function createInvite(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    if (!account || !community) return;
    setInviteStatus('Creating invitation…');
    try {
      const created = await post<CreatedInvitationResponse>(
        `/v1/communities/${community.id}/invitations`,
        {
          actorId: account.id,
          expiresInSeconds: 86_400,
          maxUses: 1,
        },
      );
      setCreatedInvite(created.token);
      setInviteStatus('Invitation created. Copy it before leaving this page.');
    } catch {
      setInviteStatus('Unable to create an invitation. Try again.');
    }
  }

  async function acceptInvite() {
    if (!account || !inviteToken) return;
    setInviteStatus('Accepting invitation…');
    try {
      await post('/v1/invitations/accept', {
        actorId: account.id,
        token: inviteToken,
      });
      setInviteStatus('Invitation accepted.');
    } catch {
      setInviteStatus('This invitation could not be accepted.');
    }
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
            <section aria-labelledby="invitation-heading">
              <h3 id="invitation-heading">Invitations</h3>
              {invitePreview && (
                <div>
                  <p>
                    Join <strong>{invitePreview.communityName}</strong> with
                    this invitation.
                  </p>
                  <button onClick={() => void acceptInvite()}>
                    Accept invitation
                  </button>
                </div>
              )}
              <form onSubmit={(event) => void createInvite(event)}>
                <button>Create one-use invitation</button>
              </form>
              {createdInvite && (
                <div>
                  <label htmlFor="created-invite">New invitation token</label>
                  <input id="created-invite" value={createdInvite} readOnly />
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(createdInvite)
                        .then(() => {
                          setInviteStatus('Invitation copied.');
                        })
                        .catch(() => {
                          setInviteStatus(
                            'Copy failed. Select the invitation manually.',
                          );
                        });
                    }}
                  >
                    Copy invitation
                  </button>
                </div>
              )}
              {inviteStatus && (
                <p role="status" aria-live="polite">
                  {inviteStatus}
                </p>
              )}
            </section>
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
