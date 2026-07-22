use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt,
    sync::{Arc, Mutex},
};
use tauri::{State, Url};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;
use zeroize::Zeroize;

const SERVICE_NAME: &str = "chat.nexa.desktop.credentials.v1";
const ACTIVE_ENTRY: &str = "active-session-v1";
const RECORD_SCHEMA_VERSION: u8 = 1;
const INDEX_SCHEMA_VERSION: u8 = 1;
const MAX_ACCOUNTS: usize = 20;
const MAX_ORIGIN_BYTES: usize = 512;
const MAX_LABEL_CHARS: usize = 80;
const MAX_LABEL_BYTES: usize = 320;
const MAX_RECORD_BYTES: usize = 2_048;
const MAX_INDEX_BYTES: usize = 512;
const SESSION_TOKEN_LENGTH: usize = 43;
const MAX_SESSION_LIFETIME_SECONDS: i64 = 366 * 24 * 60 * 60;

#[derive(Deserialize, Serialize)]
#[serde(transparent)]
struct SecretToken(String);

impl SecretToken {
    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct SecretBytes(Vec<u8>);

impl SecretBytes {
    fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialKeyInput {
    server_origin: String,
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoreSessionCredentialRequest {
    server_origin: String,
    account_id: String,
    account_label: String,
    expires_at: String,
    operation_id: String,
    make_active: bool,
    user_consented: bool,
    session_token: SecretToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CredentialError {
    InvalidInput,
    StoreUnavailable,
    StoreCorrupt,
    AccountLimitReached,
    NotFound,
    IdempotencyConflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CredentialStoreState {
    Available,
    Unavailable,
    RecoveryRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStoreStatus {
    state: CredentialStoreState,
    account_count: usize,
    max_accounts: usize,
    recovered_selection: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAccount {
    server_origin: String,
    account_id: String,
    account_label: String,
    expires_at: String,
    selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialInventory {
    accounts: Vec<StoredAccount>,
    recovered_selection: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalResult {
    removed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearResult {
    removed_count: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialRecord {
    schema_version: u8,
    server_origin: String,
    account_id: String,
    account_label: String,
    expires_at_unix: i64,
    saved_at_unix: i64,
    operation_id: String,
    session_token: SecretToken,
}

impl CredentialRecord {
    fn identity(&self) -> String {
        credential_identity(&self.server_origin, &self.account_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveIndex {
    schema_version: u8,
    generation: u64,
    active_slot: Option<u8>,
    checksum: String,
}

impl Default for ActiveIndex {
    fn default() -> Self {
        let mut index = Self {
            schema_version: INDEX_SCHEMA_VERSION,
            generation: 0,
            active_slot: None,
            checksum: String::new(),
        };
        index.checksum = index_checksum(index.generation, index.active_slot);
        index
    }
}

struct SlotRecord {
    slot: u8,
    record: CredentialRecord,
}

struct ReconciledInventory {
    records: Vec<SlotRecord>,
    active: ActiveIndex,
    recovered_selection: bool,
}

trait SecretBackend: Send + Sync {
    fn set(&self, entry: &str, secret: &[u8]) -> Result<(), CredentialError>;
    fn get(&self, entry: &str) -> Result<Option<SecretBytes>, CredentialError>;
    fn delete(&self, entry: &str) -> Result<(), CredentialError>;
}

struct KeyringBackend {
    service: String,
}

impl Default for KeyringBackend {
    fn default() -> Self {
        Self {
            service: SERVICE_NAME.to_owned(),
        }
    }
}

impl KeyringBackend {
    fn entry(&self, name: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(&self.service, name).map_err(|_| CredentialError::StoreUnavailable)
    }
}

impl SecretBackend for KeyringBackend {
    fn set(&self, entry: &str, secret: &[u8]) -> Result<(), CredentialError> {
        self.entry(entry)?
            .set_secret(secret)
            .map_err(|_| CredentialError::StoreUnavailable)
    }

    fn get(&self, entry: &str) -> Result<Option<SecretBytes>, CredentialError> {
        match self.entry(entry)?.get_secret() {
            Ok(secret) => Ok(Some(SecretBytes(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialError::StoreUnavailable),
        }
    }

    fn delete(&self, entry: &str) -> Result<(), CredentialError> {
        match self.entry(entry)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::StoreUnavailable),
        }
    }
}

trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        OffsetDateTime::now_utc().unix_timestamp()
    }
}

struct CredentialVault {
    backend: Arc<dyn SecretBackend>,
    clock: Arc<dyn Clock>,
    allow_insecure_loopback: bool,
}

impl CredentialVault {
    fn production() -> Self {
        Self {
            backend: Arc::new(KeyringBackend::default()),
            clock: Arc::new(SystemClock),
            allow_insecure_loopback: cfg!(debug_assertions),
        }
    }

    fn status(&self) -> CredentialStoreStatus {
        match self.reconcile() {
            Ok(inventory) => CredentialStoreStatus {
                state: CredentialStoreState::Available,
                account_count: inventory.records.len(),
                max_accounts: MAX_ACCOUNTS,
                recovered_selection: inventory.recovered_selection,
            },
            Err(CredentialError::StoreCorrupt) => CredentialStoreStatus {
                state: CredentialStoreState::RecoveryRequired,
                account_count: 0,
                max_accounts: MAX_ACCOUNTS,
                recovered_selection: false,
            },
            Err(_) => CredentialStoreStatus {
                state: CredentialStoreState::Unavailable,
                account_count: 0,
                max_accounts: MAX_ACCOUNTS,
                recovered_selection: false,
            },
        }
    }

    fn list(&self) -> Result<CredentialInventory, CredentialError> {
        let inventory = self.reconcile()?;
        let active_slot = inventory.active.active_slot;
        let mut accounts = inventory
            .records
            .iter()
            .map(|slot| self.public_account(slot, active_slot == Some(slot.slot)))
            .collect::<Result<Vec<_>, _>>()?;
        accounts.sort_by(|left, right| {
            left.server_origin
                .cmp(&right.server_origin)
                .then_with(|| left.account_label.cmp(&right.account_label))
                .then_with(|| left.account_id.cmp(&right.account_id))
        });
        Ok(CredentialInventory {
            accounts,
            recovered_selection: inventory.recovered_selection,
        })
    }

    fn store(
        &self,
        request: StoreSessionCredentialRequest,
    ) -> Result<StoredAccount, CredentialError> {
        let (record, make_active) = self.validated_record(request)?;
        let identity = record.identity();
        let inventory = self.reconcile()?;
        let existing = inventory
            .records
            .iter()
            .find(|slot| slot.record.identity() == identity);
        let repeated_operation = inventory
            .records
            .iter()
            .find(|slot| slot.record.operation_id == record.operation_id);

        if let Some(slot) = repeated_operation {
            if !records_match(&slot.record, &record) {
                return Err(CredentialError::IdempotencyConflict);
            }
            let active = if make_active && inventory.active.active_slot != Some(slot.slot) {
                self.persist_active(&inventory.active, Some(slot.slot))?
            } else {
                inventory.active
            };
            return self.public_account(slot, active.active_slot == Some(slot.slot));
        }

        let slot = existing
            .map(|existing| existing.slot)
            .or_else(|| first_empty_slot(&inventory.records))
            .ok_or(CredentialError::AccountLimitReached)?;
        self.write_record(slot, &record)?;

        let active = if make_active {
            self.persist_active(&inventory.active, Some(slot))?
        } else {
            inventory.active
        };
        self.public_account(
            &SlotRecord { slot, record },
            active.active_slot == Some(slot),
        )
    }

    fn select(&self, key: CredentialKeyInput) -> Result<StoredAccount, CredentialError> {
        let (origin, account_id) = self.validate_key(&key)?;
        let identity = credential_identity(&origin, &account_id);
        let inventory = self.reconcile()?;
        let slot = inventory
            .records
            .iter()
            .find(|slot| slot.record.identity() == identity)
            .ok_or(CredentialError::NotFound)?;
        let active = self.persist_active(&inventory.active, Some(slot.slot))?;
        self.public_account(slot, active.active_slot == Some(slot.slot))
    }

    fn remove(&self, key: CredentialKeyInput) -> Result<RemovalResult, CredentialError> {
        let (origin, account_id) = self.validate_key(&key)?;
        let identity = credential_identity(&origin, &account_id);
        let inventory = self.reconcile()?;
        let matching = inventory
            .records
            .iter()
            .find(|slot| slot.record.identity() == identity);
        let Some(slot) = matching else {
            return Ok(RemovalResult { removed: false });
        };

        self.backend.delete(&slot_entry(slot.slot))?;
        if inventory.active.active_slot == Some(slot.slot) {
            self.persist_active(&inventory.active, None)?;
        }
        Ok(RemovalResult { removed: true })
    }

    fn clear(&self) -> Result<ClearResult, CredentialError> {
        let mut removed_count = 0;
        let mut failed = false;
        for slot in 0..MAX_ACCOUNTS as u8 {
            match self.backend.get(&slot_entry(slot)) {
                Ok(Some(_)) => match self.backend.delete(&slot_entry(slot)) {
                    Ok(()) => removed_count += 1,
                    Err(_) => failed = true,
                },
                Ok(None) => {}
                Err(_) => failed = true,
            }
        }
        if self.backend.delete(ACTIVE_ENTRY).is_err() {
            failed = true;
        }
        if failed {
            Err(CredentialError::StoreUnavailable)
        } else {
            Ok(ClearResult { removed_count })
        }
    }

    #[cfg(test)]
    fn active_session(&self) -> Result<SecretBytes, CredentialError> {
        let inventory = self.reconcile()?;
        let active_slot = inventory
            .active
            .active_slot
            .ok_or(CredentialError::NotFound)?;
        let record = inventory
            .records
            .iter()
            .find(|slot| slot.slot == active_slot)
            .ok_or(CredentialError::NotFound)?;
        Ok(SecretBytes(record.record.session_token.as_bytes().to_vec()))
    }

    fn reconcile(&self) -> Result<ReconciledInventory, CredentialError> {
        let now = self.clock.now_unix();
        let mut records = Vec::new();
        let mut identities = HashSet::new();
        let mut operations = HashSet::new();
        for slot in 0..MAX_ACCOUNTS as u8 {
            let Some(record) = self.read_record(slot)? else {
                continue;
            };
            if record.expires_at_unix <= now {
                self.backend.delete(&slot_entry(slot))?;
                continue;
            }
            if !identities.insert(record.identity())
                || !operations.insert(record.operation_id.clone())
            {
                return Err(CredentialError::StoreCorrupt);
            }
            records.push(SlotRecord { slot, record });
        }

        let (mut active, mut recovered_selection) = match self.read_active() {
            Ok(index) => (index, false),
            Err(CredentialError::StoreCorrupt) => {
                let recovered = self.write_active(1, None)?;
                (recovered, true)
            }
            Err(error) => return Err(error),
        };
        if active
            .active_slot
            .is_some_and(|active_slot| !records.iter().any(|record| record.slot == active_slot))
        {
            active = self.persist_active(&active, None)?;
            recovered_selection = true;
        }
        Ok(ReconciledInventory {
            records,
            active,
            recovered_selection,
        })
    }

    fn validated_record(
        &self,
        request: StoreSessionCredentialRequest,
    ) -> Result<(CredentialRecord, bool), CredentialError> {
        if !request.user_consented || !valid_session_token(request.session_token.as_bytes()) {
            return Err(CredentialError::InvalidInput);
        }
        let server_origin = normalize_origin(&request.server_origin, self.allow_insecure_loopback)?;
        let account_id = canonical_uuid(&request.account_id)?;
        let account_label = normalize_label(&request.account_label)?;
        let operation_id = canonical_uuid(&request.operation_id)?;
        let expires_at = OffsetDateTime::parse(&request.expires_at, &Rfc3339)
            .map_err(|_| CredentialError::InvalidInput)?
            .unix_timestamp();
        let now = self.clock.now_unix();
        if expires_at <= now || expires_at - now > MAX_SESSION_LIFETIME_SECONDS {
            return Err(CredentialError::InvalidInput);
        }
        Ok((
            CredentialRecord {
                schema_version: RECORD_SCHEMA_VERSION,
                server_origin,
                account_id,
                account_label,
                expires_at_unix: expires_at,
                saved_at_unix: now,
                operation_id,
                session_token: request.session_token,
            },
            request.make_active,
        ))
    }

    fn validate_key(&self, key: &CredentialKeyInput) -> Result<(String, String), CredentialError> {
        Ok((
            normalize_origin(&key.server_origin, self.allow_insecure_loopback)?,
            canonical_uuid(&key.account_id)?,
        ))
    }

    fn read_record(&self, slot: u8) -> Result<Option<CredentialRecord>, CredentialError> {
        let Some(bytes) = self.backend.get(&slot_entry(slot))? else {
            return Ok(None);
        };
        if bytes.as_slice().len() > MAX_RECORD_BYTES {
            return Err(CredentialError::StoreCorrupt);
        }
        let record: CredentialRecord =
            serde_json::from_slice(bytes.as_slice()).map_err(|_| CredentialError::StoreCorrupt)?;
        self.validate_stored_record(&record)?;
        Ok(Some(record))
    }

    fn validate_stored_record(&self, record: &CredentialRecord) -> Result<(), CredentialError> {
        let server_origin = normalize_origin(&record.server_origin, self.allow_insecure_loopback)
            .map_err(|_| CredentialError::StoreCorrupt)?;
        let account_id =
            canonical_uuid(&record.account_id).map_err(|_| CredentialError::StoreCorrupt)?;
        let account_label =
            normalize_label(&record.account_label).map_err(|_| CredentialError::StoreCorrupt)?;
        let operation_id =
            canonical_uuid(&record.operation_id).map_err(|_| CredentialError::StoreCorrupt)?;
        if record.schema_version != RECORD_SCHEMA_VERSION
            || server_origin != record.server_origin
            || account_id != record.account_id
            || account_label != record.account_label
            || operation_id != record.operation_id
            || !valid_session_token(record.session_token.as_bytes())
            || record.saved_at_unix <= 0
            || record.expires_at_unix <= record.saved_at_unix
            || record.expires_at_unix - record.saved_at_unix > MAX_SESSION_LIFETIME_SECONDS
        {
            return Err(CredentialError::StoreCorrupt);
        }
        Ok(())
    }

    fn write_record(&self, slot: u8, record: &CredentialRecord) -> Result<(), CredentialError> {
        let serialized = serde_json::to_vec(record).map_err(|_| CredentialError::StoreCorrupt)?;
        let secret = SecretBytes(serialized);
        if secret.as_slice().len() > MAX_RECORD_BYTES {
            return Err(CredentialError::InvalidInput);
        }
        self.backend.set(&slot_entry(slot), secret.as_slice())
    }

    fn read_active(&self) -> Result<ActiveIndex, CredentialError> {
        let Some(bytes) = self.backend.get(ACTIVE_ENTRY)? else {
            return Ok(ActiveIndex::default());
        };
        if bytes.as_slice().len() > MAX_INDEX_BYTES {
            return Err(CredentialError::StoreCorrupt);
        }
        let index: ActiveIndex =
            serde_json::from_slice(bytes.as_slice()).map_err(|_| CredentialError::StoreCorrupt)?;
        if index.schema_version != INDEX_SCHEMA_VERSION
            || index
                .active_slot
                .is_some_and(|slot| slot as usize >= MAX_ACCOUNTS)
            || index.checksum != index_checksum(index.generation, index.active_slot)
        {
            return Err(CredentialError::StoreCorrupt);
        }
        Ok(index)
    }

    fn persist_active(
        &self,
        current: &ActiveIndex,
        active_slot: Option<u8>,
    ) -> Result<ActiveIndex, CredentialError> {
        if current.active_slot == active_slot {
            return Ok(current.clone());
        }
        let generation = current
            .generation
            .checked_add(1)
            .ok_or(CredentialError::StoreCorrupt)?;
        self.write_active(generation, active_slot)
    }

    fn write_active(
        &self,
        generation: u64,
        active_slot: Option<u8>,
    ) -> Result<ActiveIndex, CredentialError> {
        let index = ActiveIndex {
            schema_version: INDEX_SCHEMA_VERSION,
            generation,
            active_slot,
            checksum: index_checksum(generation, active_slot),
        };
        let serialized = serde_json::to_vec(&index).map_err(|_| CredentialError::StoreCorrupt)?;
        let secret = SecretBytes(serialized);
        if secret.as_slice().len() > MAX_INDEX_BYTES {
            return Err(CredentialError::StoreCorrupt);
        }
        self.backend.set(ACTIVE_ENTRY, secret.as_slice())?;
        Ok(index)
    }

    fn public_account(
        &self,
        slot: &SlotRecord,
        selected: bool,
    ) -> Result<StoredAccount, CredentialError> {
        let expires_at = OffsetDateTime::from_unix_timestamp(slot.record.expires_at_unix)
            .map_err(|_| CredentialError::StoreCorrupt)?
            .format(&Rfc3339)
            .map_err(|_| CredentialError::StoreCorrupt)?;
        Ok(StoredAccount {
            server_origin: slot.record.server_origin.clone(),
            account_id: slot.record.account_id.clone(),
            account_label: slot.record.account_label.clone(),
            expires_at,
            selected,
        })
    }
}

fn records_match(left: &CredentialRecord, right: &CredentialRecord) -> bool {
    left.server_origin == right.server_origin
        && left.account_id == right.account_id
        && left.account_label == right.account_label
        && left.expires_at_unix == right.expires_at_unix
        && left.operation_id == right.operation_id
        && left.session_token.as_bytes() == right.session_token.as_bytes()
}

fn first_empty_slot(records: &[SlotRecord]) -> Option<u8> {
    (0..MAX_ACCOUNTS as u8).find(|slot| !records.iter().any(|record| record.slot == *slot))
}

fn slot_entry(slot: u8) -> String {
    format!("session-v1-{slot:02}")
}

fn index_checksum(generation: u64, active_slot: Option<u8>) -> String {
    let active = active_slot
        .map(|slot| slot.to_string())
        .unwrap_or_else(|| "none".to_owned());
    let digest = Sha256::digest(format!("nexa-active-v1\0{generation}\0{active}").as_bytes());
    format!("{digest:x}")
}

fn credential_identity(server_origin: &str, account_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"nexa-credential-v1\0");
    digest.update(server_origin.as_bytes());
    digest.update(b"\0");
    digest.update(account_id.as_bytes());
    format!("{:x}", digest.finalize())
}

fn normalize_origin(value: &str, allow_insecure_loopback: bool) -> Result<String, CredentialError> {
    if value.is_empty() || value.len() > MAX_ORIGIN_BYTES {
        return Err(CredentialError::InvalidInput);
    }
    let url = Url::parse(value).map_err(|_| CredentialError::InvalidInput)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host_str().is_none()
    {
        return Err(CredentialError::InvalidInput);
    }
    let secure = url.scheme() == "https";
    let loopback = allow_insecure_loopback
        && url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        );
    if !secure && !loopback {
        return Err(CredentialError::InvalidInput);
    }
    Ok(url.origin().ascii_serialization())
}

fn canonical_uuid(value: &str) -> Result<String, CredentialError> {
    Uuid::parse_str(value)
        .map(|value| value.hyphenated().to_string())
        .map_err(|_| CredentialError::InvalidInput)
}

fn normalize_label(value: &str) -> Result<String, CredentialError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_LABEL_BYTES
        || trimmed.chars().count() > MAX_LABEL_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return Err(CredentialError::InvalidInput);
    }
    Ok(trimmed.to_owned())
}

fn valid_session_token(value: &[u8]) -> bool {
    value.len() == SESSION_TOKEN_LENGTH
        && value
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) struct CredentialState(Arc<Mutex<CredentialVault>>);

impl Default for CredentialState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(CredentialVault::production())))
    }
}

async fn with_vault<T, F>(
    state: &State<'_, CredentialState>,
    operation: F,
) -> Result<T, CredentialError>
where
    T: Send + 'static,
    F: FnOnce(&CredentialVault) -> Result<T, CredentialError> + Send + 'static,
{
    let vault = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let guard = vault
            .lock()
            .map_err(|_| CredentialError::StoreUnavailable)?;
        operation(&guard)
    })
    .await
    .map_err(|_| CredentialError::StoreUnavailable)?
}

#[tauri::command]
pub(crate) async fn credential_store_status(
    state: State<'_, CredentialState>,
) -> Result<CredentialStoreStatus, CredentialError> {
    Ok(with_vault(&state, |vault| Ok(vault.status()))
        .await
        .unwrap_or(CredentialStoreStatus {
            state: CredentialStoreState::Unavailable,
            account_count: 0,
            max_accounts: MAX_ACCOUNTS,
            recovered_selection: false,
        }))
}

#[tauri::command]
pub(crate) async fn list_stored_accounts(
    state: State<'_, CredentialState>,
) -> Result<CredentialInventory, CredentialError> {
    with_vault(&state, CredentialVault::list).await
}

#[tauri::command]
pub(crate) async fn store_session_credential(
    state: State<'_, CredentialState>,
    request: StoreSessionCredentialRequest,
) -> Result<StoredAccount, CredentialError> {
    with_vault(&state, move |vault| vault.store(request)).await
}

#[tauri::command]
pub(crate) async fn select_stored_account(
    state: State<'_, CredentialState>,
    key: CredentialKeyInput,
) -> Result<StoredAccount, CredentialError> {
    with_vault(&state, move |vault| vault.select(key)).await
}

#[tauri::command]
pub(crate) async fn remove_stored_account(
    state: State<'_, CredentialState>,
    key: CredentialKeyInput,
) -> Result<RemovalResult, CredentialError> {
    with_vault(&state, move |vault| vault.remove(key)).await
}

#[tauri::command]
pub(crate) async fn clear_stored_accounts(
    state: State<'_, CredentialState>,
) -> Result<ClearResult, CredentialError> {
    with_vault(&state, CredentialVault::clear).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const NOW: i64 = 1_800_000_000;
    const ACCOUNT_ONE: &str = "11111111-1111-4111-8111-111111111111";
    const ACCOUNT_TWO: &str = "22222222-2222-4222-8222-222222222222";
    const TOKEN_ONE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TOKEN_TWO: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    #[derive(Default)]
    struct FakeBackend {
        values: Mutex<HashMap<String, Vec<u8>>>,
        writes: Mutex<usize>,
        fail_entries: Mutex<HashSet<String>>,
    }

    impl FakeBackend {
        fn writes(&self) -> usize {
            *self.writes.lock().expect("writes lock")
        }

        fn fail(&self, entry: &str) {
            self.fail_entries
                .lock()
                .expect("failure lock")
                .insert(entry.to_owned());
        }

        fn recover(&self, entry: &str) {
            self.fail_entries
                .lock()
                .expect("failure lock")
                .remove(entry);
        }

        fn should_fail(&self, entry: &str) -> bool {
            self.fail_entries
                .lock()
                .expect("failure lock")
                .contains(entry)
        }
    }

    impl SecretBackend for FakeBackend {
        fn set(&self, entry: &str, secret: &[u8]) -> Result<(), CredentialError> {
            if self.should_fail(entry) {
                return Err(CredentialError::StoreUnavailable);
            }
            self.values
                .lock()
                .expect("values lock")
                .insert(entry.to_owned(), secret.to_vec());
            *self.writes.lock().expect("writes lock") += 1;
            Ok(())
        }

        fn get(&self, entry: &str) -> Result<Option<SecretBytes>, CredentialError> {
            if self.should_fail(entry) {
                return Err(CredentialError::StoreUnavailable);
            }
            Ok(self
                .values
                .lock()
                .expect("values lock")
                .get(entry)
                .cloned()
                .map(SecretBytes))
        }

        fn delete(&self, entry: &str) -> Result<(), CredentialError> {
            if self.should_fail(entry) {
                return Err(CredentialError::StoreUnavailable);
            }
            self.values.lock().expect("values lock").remove(entry);
            Ok(())
        }
    }

    struct FixedClock;

    impl Clock for FixedClock {
        fn now_unix(&self) -> i64 {
            NOW
        }
    }

    fn vault(backend: Arc<FakeBackend>) -> CredentialVault {
        CredentialVault {
            backend,
            clock: Arc::new(FixedClock),
            allow_insecure_loopback: true,
        }
    }

    fn request(
        account_id: &str,
        label: &str,
        token: &str,
        operation_id: &str,
    ) -> StoreSessionCredentialRequest {
        StoreSessionCredentialRequest {
            server_origin: "https://chat.example.test".to_owned(),
            account_id: account_id.to_owned(),
            account_label: label.to_owned(),
            expires_at: OffsetDateTime::from_unix_timestamp(NOW + 3_600)
                .expect("timestamp")
                .format(&Rfc3339)
                .expect("format timestamp"),
            operation_id: operation_id.to_owned(),
            make_active: true,
            user_consented: true,
            session_token: SecretToken(token.to_owned()),
        }
    }

    fn key(account_id: &str) -> CredentialKeyInput {
        CredentialKeyInput {
            server_origin: "https://chat.example.test".to_owned(),
            account_id: account_id.to_owned(),
        }
    }

    #[test]
    fn stores_idempotently_without_exposing_the_secret() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(Arc::clone(&backend));
        let operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let stored = vault
            .store(request(ACCOUNT_ONE, "Aster", TOKEN_ONE, operation))
            .expect("store session");
        let writes = backend.writes();
        let retried = vault
            .store(request(ACCOUNT_ONE, "Aster", TOKEN_ONE, operation))
            .expect("retry session");

        assert_eq!(stored, retried);
        assert_eq!(backend.writes(), writes);
        assert!(stored.selected);
        assert_eq!(
            vault.active_session().expect("active").as_slice(),
            TOKEN_ONE.as_bytes()
        );
        assert!(
            !serde_json::to_string(&stored)
                .expect("serialize")
                .contains(TOKEN_ONE)
        );
        assert_eq!(
            format!("{:?}", SecretToken(TOKEN_ONE.to_owned())),
            "[REDACTED]"
        );
    }

    #[test]
    fn rejects_reused_idempotency_keys_with_different_payloads() {
        let vault = vault(Arc::new(FakeBackend::default()));
        let operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        vault
            .store(request(ACCOUNT_ONE, "Aster", TOKEN_ONE, operation))
            .expect("store session");
        assert_eq!(
            vault.store(request(ACCOUNT_ONE, "Aster", TOKEN_TWO, operation)),
            Err(CredentialError::IdempotencyConflict)
        );
        assert_eq!(
            vault.store(request(ACCOUNT_TWO, "Birch", TOKEN_TWO, operation)),
            Err(CredentialError::IdempotencyConflict)
        );
        assert_eq!(vault.list().expect("list").accounts.len(), 1);
    }

    #[test]
    fn switches_accounts_and_logout_cleanup_is_idempotent() {
        let vault = vault(Arc::new(FakeBackend::default()));
        vault
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("store first");
        vault
            .store(request(
                ACCOUNT_TWO,
                "Birch",
                TOKEN_TWO,
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ))
            .expect("store second");
        assert_eq!(vault.list().expect("list").accounts.len(), 2);

        let selected = vault.select(key(ACCOUNT_ONE)).expect("select first");
        assert!(selected.selected);
        assert_eq!(
            vault.active_session().expect("active").as_slice(),
            TOKEN_ONE.as_bytes()
        );
        assert!(vault.remove(key(ACCOUNT_ONE)).expect("remove").removed);
        assert!(
            !vault
                .remove(key(ACCOUNT_ONE))
                .expect("retry remove")
                .removed
        );
        assert!(matches!(
            vault.active_session(),
            Err(CredentialError::NotFound)
        ));
    }

    #[test]
    fn can_remember_an_account_without_switching_the_active_session() {
        let vault = vault(Arc::new(FakeBackend::default()));
        vault
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("store first");
        let mut second = request(
            ACCOUNT_TWO,
            "Birch",
            TOKEN_TWO,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
        second.make_active = false;
        let stored = vault.store(second).expect("store inactive account");

        assert!(!stored.selected);
        let inventory = vault.list().expect("list accounts");
        assert_eq!(
            inventory
                .accounts
                .iter()
                .filter(|item| item.selected)
                .count(),
            1
        );
        assert_eq!(
            vault.active_session().expect("active").as_slice(),
            TOKEN_ONE.as_bytes()
        );
    }

    #[test]
    fn enforces_consent_bounds_origins_and_capacity() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(backend);
        let mut without_consent = request(
            ACCOUNT_ONE,
            "Aster",
            TOKEN_ONE,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
        without_consent.user_consented = false;
        assert_eq!(
            vault.store(without_consent),
            Err(CredentialError::InvalidInput)
        );

        let mut unsafe_origin = request(
            ACCOUNT_ONE,
            "Aster",
            TOKEN_ONE,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
        unsafe_origin.server_origin = "http://example.test".to_owned();
        assert_eq!(
            vault.store(unsafe_origin),
            Err(CredentialError::InvalidInput)
        );

        assert_eq!(
            normalize_origin("https://chat.example.test/room", false),
            Err(CredentialError::InvalidInput)
        );
        assert_eq!(
            normalize_origin("http://localhost:5173", false),
            Err(CredentialError::InvalidInput)
        );
        assert_eq!(
            normalize_origin("http://localhost:5173", true),
            Ok("http://localhost:5173".to_owned())
        );
        assert_eq!(
            normalize_origin("http://[::1]:5173", true),
            Ok("http://[::1]:5173".to_owned())
        );

        for index in 0..MAX_ACCOUNTS {
            let account_id = format!("00000000-0000-4000-8000-{index:012}");
            let operation_id = format!("10000000-0000-4000-8000-{index:012}");
            vault
                .store(request(&account_id, "Account", TOKEN_ONE, &operation_id))
                .expect("fill credential slots");
        }
        assert_eq!(
            vault.store(request(
                "ffffffff-ffff-4fff-8fff-ffffffffffff",
                "Overflow",
                TOKEN_TWO,
                "ffffffff-ffff-4fff-8fff-ffffffffffff",
            )),
            Err(CredentialError::AccountLimitReached)
        );
    }

    #[test]
    fn recovers_interrupted_active_index_writes_without_losing_sessions() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(Arc::clone(&backend));
        vault
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("store session");
        backend
            .values
            .lock()
            .expect("values lock")
            .insert(ACTIVE_ENTRY.to_owned(), b"corrupt".to_vec());

        let inventory = vault.list().expect("recover inventory");
        assert_eq!(inventory.accounts.len(), 1);
        assert!(inventory.recovered_selection);
        assert!(!inventory.accounts[0].selected);
        assert!(matches!(
            vault.active_session(),
            Err(CredentialError::NotFound)
        ));
    }

    #[test]
    fn retries_a_partial_record_write_without_creating_a_duplicate() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(Arc::clone(&backend));
        backend.fail(ACTIVE_ENTRY);
        assert_eq!(
            vault.store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            )),
            Err(CredentialError::StoreUnavailable)
        );

        backend.recover(ACTIVE_ENTRY);
        let retried = vault
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("retry partial write");
        assert!(retried.selected);
        assert_eq!(vault.list().expect("list").accounts.len(), 1);
    }

    #[test]
    fn corrupt_records_require_recovery_but_clear_remains_available() {
        let backend = Arc::new(FakeBackend::default());
        backend
            .values
            .lock()
            .expect("values lock")
            .insert(slot_entry(0), b"not-a-credential".to_vec());
        let vault = vault(Arc::clone(&backend));

        assert_eq!(vault.status().state, CredentialStoreState::RecoveryRequired);
        assert_eq!(vault.clear().expect("clear corrupt vault").removed_count, 1);
        assert_eq!(vault.status().state, CredentialStoreState::Available);
    }

    #[test]
    fn records_survive_vault_reconstruction() {
        let backend = Arc::new(FakeBackend::default());
        vault(Arc::clone(&backend))
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("store session");

        let restarted = vault(backend);
        let inventory = restarted.list().expect("list after restart");
        assert_eq!(inventory.accounts.len(), 1);
        assert!(inventory.accounts[0].selected);
        assert_eq!(
            restarted.active_session().expect("active").as_slice(),
            TOKEN_ONE.as_bytes()
        );
    }

    #[test]
    fn reports_unavailable_store_without_backend_details_and_retries_cleanup() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(Arc::clone(&backend));
        vault
            .store(request(
                ACCOUNT_ONE,
                "Aster",
                TOKEN_ONE,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ))
            .expect("store session");
        backend.fail(&slot_entry(0));

        assert_eq!(vault.clear(), Err(CredentialError::StoreUnavailable));
        assert_eq!(vault.status().state, CredentialStoreState::Unavailable);
        assert_eq!(
            serde_json::to_string(&CredentialError::StoreUnavailable).expect("serialize"),
            "\"store_unavailable\""
        );

        backend.recover(&slot_entry(0));
        assert_eq!(vault.clear().expect("retry clear").removed_count, 1);
        assert!(vault.list().expect("empty inventory").accounts.is_empty());
    }

    #[test]
    fn expired_records_are_removed_during_restart_reconciliation() {
        let backend = Arc::new(FakeBackend::default());
        let vault = vault(Arc::clone(&backend));
        let expired = CredentialRecord {
            schema_version: RECORD_SCHEMA_VERSION,
            server_origin: "https://chat.example.test".to_owned(),
            account_id: ACCOUNT_ONE.to_owned(),
            account_label: "Aster".to_owned(),
            expires_at_unix: NOW,
            saved_at_unix: NOW - 10,
            operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
            session_token: SecretToken(TOKEN_ONE.to_owned()),
        };
        vault
            .write_record(0, &expired)
            .expect("write expired record");
        vault.write_active(1, Some(0)).expect("write active index");

        let inventory = vault.list().expect("reconcile expired record");
        assert!(inventory.accounts.is_empty());
        assert!(inventory.recovered_selection);
        assert!(
            backend
                .values
                .lock()
                .expect("values lock")
                .get(&slot_entry(0))
                .is_none()
        );
    }

    #[test]
    fn concurrent_account_mutations_are_serialized() {
        let backend = Arc::new(FakeBackend::default());
        let vault = Arc::new(Mutex::new(vault(backend)));
        let handles = (0..8)
            .map(|index| {
                let vault = Arc::clone(&vault);
                std::thread::spawn(move || {
                    let account_id = format!("00000000-0000-4000-8000-{index:012}");
                    let operation_id = format!("20000000-0000-4000-8000-{index:012}");
                    vault.lock().expect("vault lock").store(request(
                        &account_id,
                        "Account",
                        TOKEN_ONE,
                        &operation_id,
                    ))
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle
                .join()
                .expect("thread joins")
                .expect("store succeeds");
        }
        assert_eq!(
            vault
                .lock()
                .expect("vault lock")
                .list()
                .expect("list")
                .accounts
                .len(),
            8
        );
    }

    #[test]
    #[ignore = "writes an ephemeral value to the host operating-system credential store"]
    fn platform_keyring_round_trip() {
        let service = format!(
            "chat.nexa.desktop.test.{}.{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let backend = KeyringBackend { service };
        let entry = "ephemeral-platform-check";
        backend
            .set(entry, b"temporary-test-value")
            .expect("set credential");
        let value = backend
            .get(entry)
            .expect("get credential")
            .expect("credential exists");
        let matched = value.as_slice() == b"temporary-test-value";
        backend.delete(entry).expect("delete credential");
        assert!(matched);
        assert!(backend.get(entry).expect("check cleanup").is_none());
    }
}
