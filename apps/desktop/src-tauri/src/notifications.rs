use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, sync::Mutex};
use tauri::{AppHandle, State, plugin::PermissionState};
use tauri_plugin_notification::NotificationExt;
use time::OffsetDateTime;
use uuid::Uuid;

const NOTIFICATION_ROUTE: &str = "/notifications";
const RATE_WINDOW_MILLISECONDS: i64 = 60_000;
const RATE_LIMIT: usize = 10;
const SEEN_LIMIT: usize = 256;
const MAX_NOTIFICATION_VERSION: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopNotificationKind {
    Mention,
    Reply,
    Invite,
    ModerationOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopNotificationRequest {
    notification_id: String,
    kind: DesktopNotificationKind,
    version: u64,
    route: String,
    privacy_mode: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopNotificationPermission {
    Granted,
    Denied,
    Prompt,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationStatus {
    supported: bool,
    permission: DesktopNotificationPermission,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopNotificationOutcome {
    Accepted,
    Duplicate,
    PermissionRequired,
    RateLimited,
    DeliveryFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationResult {
    outcome: DesktopNotificationOutcome,
    route: &'static str,
    retry_after_milliseconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopNotificationError {
    InvalidInput,
    Unavailable,
}

#[derive(Default)]
struct DeliveryGate {
    attempts: VecDeque<i64>,
    seen: VecDeque<String>,
}

impl DeliveryGate {
    fn deliver<F>(
        &mut self,
        request: DesktopNotificationRequest,
        permission: DesktopNotificationPermission,
        now_milliseconds: i64,
        show: F,
    ) -> Result<DesktopNotificationResult, DesktopNotificationError>
    where
        F: FnOnce(&'static str, &'static str) -> Result<(), ()>,
    {
        validate_request(&request)?;
        let fingerprint = delivery_fingerprint(&request.notification_id, request.version);
        if self.seen.iter().any(|seen| seen == &fingerprint) {
            return Ok(delivery_result(DesktopNotificationOutcome::Duplicate, 0));
        }
        if permission != DesktopNotificationPermission::Granted {
            return Ok(delivery_result(
                DesktopNotificationOutcome::PermissionRequired,
                0,
            ));
        }

        if self
            .attempts
            .front()
            .is_some_and(|earliest| now_milliseconds < *earliest)
        {
            self.attempts.clear();
        }
        while self.attempts.front().is_some_and(|attempt| {
            now_milliseconds.saturating_sub(*attempt) >= RATE_WINDOW_MILLISECONDS
        }) {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= RATE_LIMIT {
            let retry_after = self
                .attempts
                .front()
                .map(|attempt| {
                    RATE_WINDOW_MILLISECONDS
                        .saturating_sub(now_milliseconds.saturating_sub(*attempt))
                        .max(1) as u64
                })
                .unwrap_or(1);
            return Ok(delivery_result(
                DesktopNotificationOutcome::RateLimited,
                retry_after,
            ));
        }
        self.attempts.push_back(now_milliseconds);

        let (title, body) = notification_copy(request.kind, request.privacy_mode);
        if show(title, body).is_err() {
            return Ok(delivery_result(
                DesktopNotificationOutcome::DeliveryFailed,
                0,
            ));
        }
        self.seen.push_back(fingerprint);
        while self.seen.len() > SEEN_LIMIT {
            self.seen.pop_front();
        }
        Ok(delivery_result(DesktopNotificationOutcome::Accepted, 0))
    }
}

pub(crate) struct DesktopNotificationState(Mutex<DeliveryGate>);

impl Default for DesktopNotificationState {
    fn default() -> Self {
        Self(Mutex::new(DeliveryGate::default()))
    }
}

fn validate_request(request: &DesktopNotificationRequest) -> Result<(), DesktopNotificationError> {
    let notification_id = Uuid::parse_str(&request.notification_id)
        .map_err(|_| DesktopNotificationError::InvalidInput)?;
    if notification_id.hyphenated().to_string() != request.notification_id.to_lowercase()
        || request.version == 0
        || request.version > MAX_NOTIFICATION_VERSION
        || request.route != NOTIFICATION_ROUTE
    {
        return Err(DesktopNotificationError::InvalidInput);
    }
    Ok(())
}

fn delivery_fingerprint(notification_id: &str, version: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"nexa-desktop-notification-v1\0");
    digest.update(notification_id.as_bytes());
    digest.update(b"\0");
    digest.update(version.to_string().as_bytes());
    format!("{:x}", digest.finalize())
}

fn notification_copy(
    kind: DesktopNotificationKind,
    privacy_mode: bool,
) -> (&'static str, &'static str) {
    if privacy_mode {
        return (
            "Nexa Chat notification",
            "Open Nexa Chat to view this update.",
        );
    }
    let title = match kind {
        DesktopNotificationKind::Mention => "New mention",
        DesktopNotificationKind::Reply => "New reply",
        DesktopNotificationKind::Invite => "New invitation",
        DesktopNotificationKind::ModerationOutcome => "Moderation update",
    };
    (title, "Open Nexa Chat to view this update.")
}

fn delivery_result(
    outcome: DesktopNotificationOutcome,
    retry_after_milliseconds: u64,
) -> DesktopNotificationResult {
    DesktopNotificationResult {
        outcome,
        route: NOTIFICATION_ROUTE,
        retry_after_milliseconds,
    }
}

fn permission_state(value: PermissionState) -> DesktopNotificationPermission {
    match value {
        PermissionState::Granted => DesktopNotificationPermission::Granted,
        PermissionState::Denied => DesktopNotificationPermission::Denied,
        PermissionState::Prompt | PermissionState::PromptWithRationale => {
            DesktopNotificationPermission::Prompt
        }
    }
}

fn now_milliseconds() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

#[tauri::command]
pub(crate) fn desktop_notification_status(app: AppHandle) -> DesktopNotificationStatus {
    let permission = app
        .notification()
        .permission_state()
        .map(permission_state)
        .unwrap_or(DesktopNotificationPermission::Unavailable);
    DesktopNotificationStatus {
        supported: cfg!(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux"
        )),
        permission,
    }
}

#[tauri::command]
pub(crate) fn request_desktop_notification_permission(
    app: AppHandle,
    user_initiated: bool,
) -> Result<DesktopNotificationStatus, DesktopNotificationError> {
    if !user_initiated {
        return Err(DesktopNotificationError::InvalidInput);
    }
    let permission = app
        .notification()
        .request_permission()
        .map(permission_state)
        .map_err(|_| DesktopNotificationError::Unavailable)?;
    Ok(DesktopNotificationStatus {
        supported: cfg!(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux"
        )),
        permission,
    })
}

#[tauri::command]
pub(crate) fn deliver_desktop_notification(
    app: AppHandle,
    state: State<'_, DesktopNotificationState>,
    request: DesktopNotificationRequest,
) -> Result<DesktopNotificationResult, DesktopNotificationError> {
    let permission = app
        .notification()
        .permission_state()
        .map(permission_state)
        .unwrap_or(DesktopNotificationPermission::Unavailable);
    let mut gate = state
        .0
        .lock()
        .map_err(|_| DesktopNotificationError::Unavailable)?;
    gate.deliver(request, permission, now_milliseconds(), |title, body| {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    fn request(index: u128) -> DesktopNotificationRequest {
        DesktopNotificationRequest {
            notification_id: Uuid::from_u128(index).hyphenated().to_string(),
            kind: DesktopNotificationKind::Mention,
            version: 1,
            route: NOTIFICATION_ROUTE.to_owned(),
            privacy_mode: true,
        }
    }

    #[test]
    fn validates_fixed_routes_identifiers_and_versions() {
        let mut gate = DeliveryGate::default();
        let mut unsafe_route = request(1);
        unsafe_route.route = "https://private.example/messages/secret".to_owned();
        assert_eq!(
            gate.deliver(
                unsafe_route,
                DesktopNotificationPermission::Granted,
                1,
                |_, _| Ok(())
            ),
            Err(DesktopNotificationError::InvalidInput)
        );
        let mut oversized_version = request(2);
        oversized_version.version = MAX_NOTIFICATION_VERSION + 1;
        assert_eq!(
            gate.deliver(
                oversized_version,
                DesktopNotificationPermission::Granted,
                1,
                |_, _| Ok(())
            ),
            Err(DesktopNotificationError::InvalidInput)
        );
    }

    #[test]
    fn renders_only_constant_privacy_aware_copy() {
        let captured = Rc::new(RefCell::new(Vec::new()));
        for (index, privacy_mode) in [(10, true), (11, false)] {
            let captured = Rc::clone(&captured);
            let mut value = request(index);
            value.privacy_mode = privacy_mode;
            DeliveryGate::default()
                .deliver(
                    value,
                    DesktopNotificationPermission::Granted,
                    1,
                    move |title, body| {
                        captured.borrow_mut().push((title, body));
                        Ok(())
                    },
                )
                .expect("deliver notification");
        }
        assert_eq!(captured.borrow()[0].0, "Nexa Chat notification");
        assert_eq!(captured.borrow()[1].0, "New mention");
        assert!(
            captured
                .borrow()
                .iter()
                .all(|(_, body)| *body == "Open Nexa Chat to view this update.")
        );
    }

    #[test]
    fn deduplicates_success_and_retries_provider_failure() {
        let mut gate = DeliveryGate::default();
        let failed = gate
            .deliver(
                request(20),
                DesktopNotificationPermission::Granted,
                1,
                |_, _| Err(()),
            )
            .expect("bounded failure");
        assert_eq!(failed.outcome, DesktopNotificationOutcome::DeliveryFailed);
        let delivered = gate
            .deliver(
                request(20),
                DesktopNotificationPermission::Granted,
                2,
                |_, _| Ok(()),
            )
            .expect("retry delivery");
        assert_eq!(delivered.outcome, DesktopNotificationOutcome::Accepted);
        let duplicate = gate
            .deliver(
                request(20),
                DesktopNotificationPermission::Granted,
                3,
                |_, _| panic!("duplicates are not rendered"),
            )
            .expect("duplicate result");
        assert_eq!(duplicate.outcome, DesktopNotificationOutcome::Duplicate);
    }

    #[test]
    fn permission_denial_is_non_prompting_and_does_not_consume_delivery() {
        let mut gate = DeliveryGate::default();
        let denied = gate
            .deliver(
                request(30),
                DesktopNotificationPermission::Denied,
                1,
                |_, _| panic!("denied notifications are not rendered"),
            )
            .expect("permission result");
        assert_eq!(
            denied.outcome,
            DesktopNotificationOutcome::PermissionRequired
        );
        assert!(gate.attempts.is_empty());
        assert!(gate.seen.is_empty());
    }

    #[test]
    fn rate_limit_returns_stable_retry_and_recovers_at_boundary() {
        let mut gate = DeliveryGate::default();
        for index in 1..=RATE_LIMIT {
            let result = gate
                .deliver(
                    request(100 + index as u128),
                    DesktopNotificationPermission::Granted,
                    1_000,
                    |_, _| Ok(()),
                )
                .expect("within rate limit");
            assert_eq!(result.outcome, DesktopNotificationOutcome::Accepted);
        }
        let limited = gate
            .deliver(
                request(999),
                DesktopNotificationPermission::Granted,
                1_001,
                |_, _| panic!("limited notifications are not rendered"),
            )
            .expect("rate limit result");
        assert_eq!(limited.outcome, DesktopNotificationOutcome::RateLimited);
        assert_eq!(limited.retry_after_milliseconds, 59_999);

        let recovered = gate
            .deliver(
                request(999),
                DesktopNotificationPermission::Granted,
                61_000,
                |_, _| Ok(()),
            )
            .expect("boundary recovery");
        assert_eq!(recovered.outcome, DesktopNotificationOutcome::Accepted);
    }

    #[test]
    #[ignore = "shows one generic notification through the host desktop provider"]
    fn platform_notification_provider_smoke() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build notification smoke application");
        assert_eq!(
            permission_state(
                app.notification()
                    .permission_state()
                    .expect("read host notification permission")
            ),
            DesktopNotificationPermission::Granted
        );
        app.notification()
            .builder()
            .title("Nexa Chat notification test")
            .body("Generic test notification. No account or message data is included.")
            .show()
            .expect("host provider accepts notification");
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}
