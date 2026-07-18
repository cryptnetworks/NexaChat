export function invitationTokenFromHash(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
