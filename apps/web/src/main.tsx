import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  websocketServerMessageSchema,
  authSessionSchema,
  type AccountResponse,
  type AuthSessionResponse,
  type AuthProfileResponse,
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
import { publicRequestError } from './http.js';
import {
  accessibleTimestamp,
  createRateLimitedAnnouncer,
  type RateLimitedAnnouncer,
} from './accessibility.js';
import {
  publishSessionSignal,
  subscribeSessionSignals,
} from './session-sync.js';

type Message = RealtimeEnvelope['payload']['message'];

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw publicRequestError(
      response.status,
      response.headers.get('retry-after'),
    );
  return response.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok)
    throw publicRequestError(
      response.status,
      response.headers.get('retry-after'),
    );
  return response.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-nexa-csrf': '1' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw publicRequestError(
      response.status,
      response.headers.get('retry-after'),
    );
  return response.json() as Promise<T>;
}

async function mutate(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexa-csrf': '1' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw publicRequestError(
      response.status,
      response.headers.get('retry-after'),
    );
}

async function sessionMutation(
  path: string,
  method: 'DELETE' | 'POST' = 'POST',
): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: { 'x-nexa-csrf': '1' },
  });
  if (!response.ok)
    throw publicRequestError(
      response.status,
      response.headers.get('retry-after'),
    );
}

function App() {
  const [account, setAccount] = useState<AccountResponse>();
  const [community, setCommunity] = useState<CommunityResponse>();
  const [space, setSpace] = useState<SpaceResponse>();
  const [categories, setCategories] = useState<CategoryResponse[]>([]);
  const [spaces, setSpaces] = useState<SpaceResponse[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [profile, setProfile] = useState<AuthProfileResponse>();
  const [authState, setAuthState] = useState<
    'loading' | 'signed-in' | 'signed-out'
  >('loading');
  const [authStatus, setAuthStatus] = useState('Checking your session…');
  const [authBusy, setAuthBusy] = useState(false);
  const [sessions, setSessions] = useState<AuthSessionResponse[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionStatus, setSessionStatus] = useState('');
  const [pendingRevocation, setPendingRevocation] = useState<string | null>(
    null,
  );
  const [profileStatus, setProfileStatus] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [inviteToken] = useState(() => invitationTokenFromHash(location.hash));
  const [invitePreview, setInvitePreview] =
    useState<InvitationPreviewResponse>();
  const [createdInvite, setCreatedInvite] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');
  const [realtimeAnnouncement, setRealtimeAnnouncement] = useState('');
  const beginButton = useRef<HTMLButtonElement>(null);
  const restoreBeginFocus = useRef(false);
  const conversationHeading = useRef<HTMLHeadingElement>(null);
  const confirmRevocationButton = useRef<HTMLButtonElement>(null);
  const confirmationDialog = useRef<HTMLDivElement>(null);
  const sessionsHeading = useRef<HTMLHeadingElement>(null);
  const revocationTrigger = useRef<HTMLButtonElement>(null);
  const realtimeAnnouncer = useRef<RateLimitedAnnouncer | null>(null);
  const realtimeCursor = useRef({
    sequence: 0,
    seenEventIds: new Set<string>(),
  });

  useEffect(() => {
    if (inviteToken)
      history.replaceState(null, '', `${location.pathname}${location.search}`);
  }, [inviteToken]);

  const endLocalSession = useCallback((message: string) => {
    setProfile(undefined);
    setSessions([]);
    setAccount(undefined);
    setCommunity(undefined);
    setSpace(undefined);
    setMessages([]);
    setAuthState('signed-out');
    setAuthStatus(message);
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      const response = await fetch('/v1/account');
      if (!response.ok) {
        endLocalSession(
          response.status === 401
            ? 'Sign in to continue.'
            : 'Your session could not be verified. Sign in again.',
        );
        return;
      }
      const nextProfile = (await response.json()) as AuthProfileResponse;
      setProfile(nextProfile);
      setAuthState('signed-in');
      setAuthStatus('');
      setSessionsLoading(true);
      const sessionResponse = await fetch('/v1/sessions');
      if (!sessionResponse.ok) {
        if (sessionResponse.status === 401)
          endLocalSession('Your session ended. Sign in again.');
        else setSessionStatus('Unable to load signed-in devices.');
        return;
      }
      setSessions(
        authSessionSchema.array().parse(await sessionResponse.json()),
      );
      setSessionStatus('');
    } catch {
      endLocalSession('Account services are unavailable. Try again.');
    } finally {
      setSessionsLoading(false);
    }
  }, [endLocalSession]);

  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);

  useEffect(
    () =>
      subscribeSessionSignals((signal) => {
        if (signal === 'signed_out') {
          endLocalSession('Your session ended in another tab.');
          return;
        }
        void refreshIdentity();
      }),
    [endLocalSession, refreshIdentity],
  );

  useEffect(() => {
    if (!pendingRevocation) return;
    confirmRevocationButton.current?.focus();
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPendingRevocation(null);
        queueMicrotask(() => revocationTrigger.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...dialog.querySelectorAll<HTMLButtonElement>('button'),
      ];
      const first = controls.at(0);
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingRevocation]);

  useEffect(
    () => () => {
      realtimeAnnouncer.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    if (space) conversationHeading.current?.focus();
  }, [space]);

  useEffect(() => {
    if (!loading && restoreBeginFocus.current) {
      restoreBeginFocus.current = false;
      beginButton.current?.focus();
    }
  }, [loading]);

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
    if (!profile || !account || !space) return;
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
  }, [account, profile, space]);

  useEffect(() => {
    if (!profile || !account || !space) return;
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
          realtimeAnnouncer.current ??= createRateLimitedAnnouncer(
            setRealtimeAnnouncement,
          );
          realtimeAnnouncer.current.announceMessage();
          return;
        }
        const control = websocketServerMessageSchema.safeParse(raw);
        if (control.success && control.data.type === 'error') {
          if (control.data.error === 'unauthenticated') {
            endLocalSession('Your session ended. Sign in again.');
            publishSessionSignal('signed_out');
          } else
            setError(`Realtime connection rejected (${control.data.error})`);
        }
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
  }, [account, endLocalSession, profile, space]);

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
      restoreBeginFocus.current = true;
      setError(reason instanceof Error ? reason.message : 'Unable to start');
    } finally {
      setLoading(false);
    }
  }

  async function send(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const formElement = form.currentTarget;
    const data = new FormData(formElement);
    if (!account || !space) return;
    try {
      setError('');
      await post(`/v1/spaces/${space.id}/messages`, {
        authorId: account.id,
        body: data.get('message'),
        idempotencyKey: crypto.randomUUID(),
      });
      formElement.reset();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to send message',
      );
    }
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

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    const data = new FormData(event.currentTarget);
    const username = data.get('profile-username');
    const displayName = data.get('profile-display-name');
    setSavingProfile(true);
    setProfileStatus('Saving profile…');
    try {
      const updated = await patch<AuthProfileResponse>('/v1/account', {
        username: typeof username === 'string' ? username : '',
        displayName: typeof displayName === 'string' ? displayName : '',
        expectedVersion: profile.version,
      });
      setProfile(updated);
      setProfileStatus('Profile saved.');
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'Unable to save profile.';
      setProfileStatus(
        message.includes('(409)')
          ? 'Profile changed in another session. Reload before trying again.'
          : 'Unable to save profile. Check the fields and try again.',
      );
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = data.get('current-password');
    const newPassword = data.get('new-password');
    const confirmation = data.get('confirm-password');
    if (
      typeof currentPassword !== 'string' ||
      typeof newPassword !== 'string' ||
      newPassword !== confirmation
    ) {
      setPasswordStatus('New password and confirmation must match.');
      return;
    }
    setChangingPassword(true);
    setPasswordStatus('Changing password…');
    try {
      await mutate('/v1/account/password', { currentPassword, newPassword });
      form.reset();
      publishSessionSignal('credentials_rotated');
      await refreshIdentity();
      setPasswordStatus(
        'Password changed. Other signed-in devices have been signed out.',
      );
    } catch {
      setPasswordStatus(
        'Password could not be changed. Check your entries and try again.',
      );
    } finally {
      setChangingPassword(false);
    }
  }

  async function registerAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setAuthBusy(true);
    setAuthStatus('Creating account…');
    try {
      await post('/v1/auth/register', {
        username: data.get('registration-username'),
        displayName: data.get('registration-display-name'),
        password: data.get('registration-password'),
      });
      await refreshIdentity();
      publishSessionSignal('sessions_changed');
      setAuthStatus('Account created and signed in.');
    } catch {
      setAuthStatus(
        'Account could not be created. Check the fields and try again.',
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function loginAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setAuthBusy(true);
    setAuthStatus('Signing in…');
    try {
      await post('/v1/auth/login', {
        username: data.get('login-username'),
        password: data.get('login-password'),
      });
      form.reset();
      await refreshIdentity();
      publishSessionSignal('sessions_changed');
      setAuthStatus('Signed in.');
    } catch {
      setAuthStatus('Sign-in failed. Check your entries and try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    setSessionStatus('Signing out…');
    try {
      await sessionMutation('/v1/auth/logout');
    } finally {
      endLocalSession('Signed out.');
      publishSessionSignal('signed_out');
    }
  }

  async function confirmSessionRevocation() {
    if (!pendingRevocation) return;
    const selection = pendingRevocation;
    setPendingRevocation(null);
    queueMicrotask(() => sessionsHeading.current?.focus());
    setSessionsLoading(true);
    setSessionStatus('Updating signed-in devices…');
    try {
      if (selection === 'others')
        await sessionMutation('/v1/sessions/revoke-others');
      else
        await sessionMutation(
          `/v1/sessions/${encodeURIComponent(selection)}`,
          'DELETE',
        );
      await refreshIdentity();
      publishSessionSignal('sessions_changed');
      setSessionStatus(
        selection === 'others'
          ? 'All other devices were signed out.'
          : 'The selected device was signed out.',
      );
    } catch {
      setSessionStatus('Signed-in devices could not be updated. Try again.');
    } finally {
      setSessionsLoading(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#conversation-heading">
        Skip to conversation
      </a>
      <main>
        <aside aria-labelledby="community-heading">
          <div className="mark" aria-hidden="true">
            N
          </div>
          <p className="eyebrow">Community</p>
          <h1 id="community-heading">{community?.name ?? 'Nexa Chat'}</h1>
          <p className="muted">A calm place for shared work.</p>
          {authState === 'loading' && (
            <p role="status" aria-live="polite">
              {authStatus}
            </p>
          )}
          {authState === 'signed-out' && (
            <section className="account-access" aria-label="Account access">
              <h2>Sign in</h2>
              <form onSubmit={(event) => void loginAccount(event)}>
                <label htmlFor="login-username">Username</label>
                <input
                  id="login-username"
                  name="login-username"
                  autoComplete="username"
                  minLength={3}
                  maxLength={32}
                  required
                />
                <label htmlFor="login-password">Password</label>
                <input
                  id="login-password"
                  name="login-password"
                  type="password"
                  autoComplete="current-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
                <button type="submit" disabled={authBusy} aria-busy={authBusy}>
                  {authBusy ? 'Working…' : 'Sign in'}
                </button>
              </form>
              <h2>Create account</h2>
              <form onSubmit={(event) => void registerAccount(event)}>
                <label htmlFor="registration-username">Username</label>
                <input
                  id="registration-username"
                  name="registration-username"
                  autoComplete="username"
                  minLength={3}
                  maxLength={32}
                  required
                />
                <label htmlFor="registration-display-name">Display name</label>
                <input
                  id="registration-display-name"
                  name="registration-display-name"
                  autoComplete="name"
                  maxLength={80}
                  required
                />
                <label htmlFor="registration-password">Password</label>
                <input
                  id="registration-password"
                  name="registration-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
                <button type="submit" disabled={authBusy} aria-busy={authBusy}>
                  {authBusy ? 'Working…' : 'Create account'}
                </button>
              </form>
              <p role="status" aria-live="polite" aria-atomic="true">
                {authStatus}
              </p>
            </section>
          )}
          {profile && (
            <div className="account-controls">
              <section
                className="profile-editor account-summary"
                aria-labelledby="account-summary-heading"
              >
                <h2 id="account-summary-heading">Account</h2>
                <p>
                  <strong>{profile.displayName}</strong>
                  <br />@{profile.username}
                </p>
                <button type="button" onClick={() => void logout()}>
                  Sign out
                </button>
                <p role="status" aria-live="polite" aria-atomic="true">
                  {authStatus}
                </p>
              </section>
              <section
                className="profile-editor"
                aria-labelledby="profile-heading"
              >
                <h2 id="profile-heading">Your profile</h2>
                <form
                  key={profile.version}
                  onSubmit={(event) => void saveProfile(event)}
                >
                  <label htmlFor="profile-username">Username</label>
                  <input
                    id="profile-username"
                    name="profile-username"
                    defaultValue={profile.username}
                    minLength={3}
                    maxLength={32}
                    autoComplete="username"
                    required
                  />
                  <label htmlFor="profile-display-name">Display name</label>
                  <input
                    id="profile-display-name"
                    name="profile-display-name"
                    defaultValue={profile.displayName}
                    maxLength={80}
                    autoComplete="name"
                    required
                  />
                  <button
                    type="submit"
                    disabled={savingProfile}
                    aria-busy={savingProfile}
                  >
                    {savingProfile ? 'Saving…' : 'Save profile'}
                  </button>
                </form>
                <p role="status" aria-live="polite" aria-atomic="true">
                  {profileStatus}
                </p>
              </section>
              <section
                className="profile-editor"
                aria-labelledby="password-heading"
              >
                <h2 id="password-heading">Change password</h2>
                <form onSubmit={(event) => void changePassword(event)}>
                  <label htmlFor="current-password">Current password</label>
                  <input
                    id="current-password"
                    name="current-password"
                    type="password"
                    autoComplete="current-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                  <label htmlFor="new-password">New password</label>
                  <input
                    id="new-password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                  <label htmlFor="confirm-password">Confirm new password</label>
                  <input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                  <button
                    type="submit"
                    disabled={changingPassword}
                    aria-busy={changingPassword}
                  >
                    {changingPassword ? 'Changing…' : 'Change password'}
                  </button>
                </form>
                <p role="status" aria-live="polite" aria-atomic="true">
                  {passwordStatus}
                </p>
              </section>
              <section
                className="profile-editor session-inventory"
                aria-labelledby="sessions-heading"
                aria-busy={sessionsLoading}
              >
                <h2 id="sessions-heading" ref={sessionsHeading} tabIndex={-1}>
                  Signed-in devices
                </h2>
                <p className="muted">
                  Device names and precise locations are not collected.
                </p>
                {sessionsLoading && <p>Loading signed-in devices…</p>}
                {!sessionsLoading && sessions.length === 0 && (
                  <p className="empty">No active sessions were found.</p>
                )}
                {!sessionsLoading && sessions.length > 0 && (
                  <ul>
                    {sessions.map((session) => (
                      <li key={session.handle}>
                        <strong>
                          {session.current
                            ? 'Current device'
                            : 'Other signed-in device'}
                        </strong>
                        <span>
                          Active {accessibleTimestamp(session.lastSeenAt)}
                        </span>
                        <span>
                          Signed in {accessibleTimestamp(session.createdAt)}
                        </span>
                        {!session.current && (
                          <button
                            type="button"
                            onClick={(event) => {
                              revocationTrigger.current = event.currentTarget;
                              setPendingRevocation(session.handle);
                            }}
                          >
                            Sign out device
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={
                    sessionsLoading ||
                    !sessions.some((session) => !session.current)
                  }
                  onClick={(event) => {
                    revocationTrigger.current = event.currentTarget;
                    setPendingRevocation('others');
                  }}
                >
                  Sign out all other devices
                </button>
                {pendingRevocation && (
                  <div
                    ref={confirmationDialog}
                    className="confirmation"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="revoke-confirmation-heading"
                    aria-describedby="revoke-confirmation-description"
                  >
                    <h3 id="revoke-confirmation-heading">
                      Confirm device sign-out
                    </h3>
                    <p id="revoke-confirmation-description">
                      {pendingRevocation === 'others'
                        ? 'Every other signed-in device will lose access immediately.'
                        : 'This signed-in device will lose access immediately.'}
                    </p>
                    <button
                      ref={confirmRevocationButton}
                      type="button"
                      onClick={() => void confirmSessionRevocation()}
                    >
                      Confirm sign-out
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingRevocation(null);
                        queueMicrotask(() =>
                          revocationTrigger.current?.focus(),
                        );
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <p role="status" aria-live="polite" aria-atomic="true">
                  {sessionStatus}
                </p>
              </section>
            </div>
          )}
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
                        aria-current={
                          item.id === space?.id ? 'page' : undefined
                        }
                        type="button"
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
        <section
          className="conversation"
          aria-labelledby="conversation-heading"
        >
          <header>
            <div>
              <p className="eyebrow">Text space</p>
              <h2
                id="conversation-heading"
                ref={conversationHeading}
                tabIndex={-1}
              >
                {space?.name ?? 'Welcome'}
              </h2>
            </div>
            <span className="status">Local development</span>
          </header>
          {!space ? (
            <div className="welcome">
              <span className="orb">✦</span>
              <h2>Start a small community</h2>
              <p>
                This guided development flow creates a local identity,
                community, and text space.
              </p>
              <button
                ref={beginButton}
                type="button"
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
              <div className="messages" aria-busy={loadingHistory}>
                {loadingHistory && <p className="empty">Loading history…</p>}
                {!loadingHistory && messages.length === 0 && (
                  <p className="empty">
                    This space is ready. Write the first note.
                  </p>
                )}
                {messages.map((message) => (
                  <article
                    key={message.id}
                    aria-label={`Message from Local Explorer, sent ${accessibleTimestamp(message.createdAt)}`}
                  >
                    <span className="avatar" aria-hidden="true">
                      LE
                    </span>
                    <div>
                      <strong>Local Explorer</strong>
                      <time
                        dateTime={message.createdAt}
                        aria-label={`Sent ${accessibleTimestamp(message.createdAt)}`}
                      >
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
                          <span>Message deleted</span>
                        ) : (
                          message.body
                        )}
                      </p>
                      {!message.deletedAt &&
                        message.updatedAt !== message.createdAt && (
                          <span className="muted">(edited)</span>
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
              <p
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {realtimeAnnouncement}
              </p>
              <form className="composer" onSubmit={(event) => void send(event)}>
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
                <button type="submit">Send message</button>
              </form>
              <section
                className="invitations"
                aria-labelledby="invitation-heading"
              >
                <h3 id="invitation-heading">Invitations</h3>
                {invitePreview && (
                  <div>
                    <p>
                      Join <strong>{invitePreview.communityName}</strong> with
                      this invitation.
                    </p>
                    <button type="button" onClick={() => void acceptInvite()}>
                      Accept invitation
                    </button>
                  </div>
                )}
                <form
                  className="invitation-actions"
                  onSubmit={(event) => void createInvite(event)}
                >
                  <button type="submit">Create one-use invitation</button>
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
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
