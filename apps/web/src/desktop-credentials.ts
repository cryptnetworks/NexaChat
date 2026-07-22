import { invoke, isTauri } from '@tauri-apps/api/core';

export type CredentialStoreState =
  'available' | 'unavailable' | 'recovery_required';

export interface CredentialStoreStatus {
  state: CredentialStoreState;
  accountCount: number;
  maxAccounts: number;
  recoveredSelection: boolean;
}

export interface StoredDesktopAccount {
  serverOrigin: string;
  accountId: string;
  accountLabel: string;
  expiresAt: string;
  selected: boolean;
}

export interface CredentialInventory {
  accounts: StoredDesktopAccount[];
  recoveredSelection: boolean;
}

export interface CredentialKey {
  serverOrigin: string;
  accountId: string;
}

export interface StoreSessionCredentialRequest extends CredentialKey {
  accountLabel: string;
  expiresAt: string;
  operationId: string;
  makeActive: boolean;
  userConsented: boolean;
  sessionToken: string;
}

export type CredentialErrorCode =
  | 'invalid_input'
  | 'store_unavailable'
  | 'store_corrupt'
  | 'account_limit_reached'
  | 'not_found'
  | 'idempotency_conflict';

const credentialErrors = new Set<CredentialErrorCode>([
  'invalid_input',
  'store_unavailable',
  'store_corrupt',
  'account_limit_reached',
  'not_found',
  'idempotency_conflict',
]);

type InvokeCommand = (
  command: string,
  argumentsValue?: Record<string, unknown>,
) => Promise<unknown>;

export class DesktopCredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
    this.name = 'DesktopCredentialError';
  }
}

export interface DesktopCredentialClient {
  status(): Promise<CredentialStoreStatus>;
  list(): Promise<CredentialInventory>;
  store(request: StoreSessionCredentialRequest): Promise<StoredDesktopAccount>;
  select(key: CredentialKey): Promise<StoredDesktopAccount>;
  remove(key: CredentialKey): Promise<{ removed: boolean }>;
  clear(): Promise<{ removedCount: number }>;
}

export function createDesktopCredentialClient(
  invokeCommand: InvokeCommand = (command, argumentsValue) =>
    invoke<unknown>(command, argumentsValue),
  desktop = isTauri(),
): DesktopCredentialClient | undefined {
  if (!desktop) return undefined;

  const call = async <T>(
    command: string,
    argumentsValue?: Record<string, unknown>,
  ): Promise<T> => {
    try {
      return (await invokeCommand(command, argumentsValue)) as T;
    } catch (reason) {
      throw new DesktopCredentialError(errorCode(reason));
    }
  };

  return {
    async status() {
      const value = await call<unknown>('credential_store_status');
      if (!isStatus(value)) throw new DesktopCredentialError('store_corrupt');
      return value;
    },
    async list() {
      const value = await call<unknown>('list_stored_accounts');
      if (!isInventory(value))
        throw new DesktopCredentialError('store_corrupt');
      return value;
    },
    async store(request) {
      const value = await call<unknown>('store_session_credential', {
        request,
      });
      if (!isAccount(value)) throw new DesktopCredentialError('store_corrupt');
      return value;
    },
    async select(key) {
      const value = await call<unknown>('select_stored_account', { key });
      if (!isAccount(value)) throw new DesktopCredentialError('store_corrupt');
      return value;
    },
    async remove(key) {
      const value = await call<unknown>('remove_stored_account', { key });
      if (!isRecord(value) || typeof value.removed !== 'boolean')
        throw new DesktopCredentialError('store_corrupt');
      return { removed: value.removed };
    },
    async clear() {
      const value = await call<unknown>('clear_stored_accounts');
      if (
        !isRecord(value) ||
        !Number.isInteger(value.removedCount) ||
        typeof value.removedCount !== 'number' ||
        value.removedCount < 0 ||
        value.removedCount > 20
      )
        throw new DesktopCredentialError('store_corrupt');
      return { removedCount: value.removedCount };
    },
  };
}

function errorCode(reason: unknown): CredentialErrorCode {
  return typeof reason === 'string' &&
    credentialErrors.has(reason as CredentialErrorCode)
    ? (reason as CredentialErrorCode)
    : 'store_unavailable';
}

function isStatus(value: unknown): value is CredentialStoreStatus {
  if (!isRecord(value)) return false;
  return (
    (value.state === 'available' ||
      value.state === 'unavailable' ||
      value.state === 'recovery_required') &&
    isBoundedCount(value.accountCount) &&
    value.maxAccounts === 20 &&
    typeof value.recoveredSelection === 'boolean'
  );
}

function isInventory(value: unknown): value is CredentialInventory {
  if (
    !isRecord(value) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 20 ||
    typeof value.recoveredSelection !== 'boolean'
  )
    return false;
  return value.accounts.every(isAccount);
}

function isAccount(value: unknown): value is StoredDesktopAccount {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.serverOrigin, 512) &&
    isBoundedString(value.accountId, 36) &&
    isBoundedString(value.accountLabel, 320) &&
    isBoundedString(value.expiresAt, 64) &&
    typeof value.selected === 'boolean'
  );
}

function isBoundedCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 20
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
