mod credentials;
mod notifications;

use credentials::{
    CredentialState, clear_stored_accounts, credential_store_status, list_stored_accounts,
    remove_stored_account, select_stored_account, store_session_credential,
};
use notifications::{
    DesktopNotificationState, deliver_desktop_notification, desktop_notification_status,
    request_desktop_notification_permission,
};
use tauri::{Manager, Url, webview::NewWindowResponse};
use tauri_plugin_opener::OpenerExt;

fn has_untrusted_authority(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

fn navigation_is_allowed(url: &Url, development: bool) -> bool {
    if has_untrusted_authority(url) {
        return false;
    }

    let production_origin = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    );
    let development_origin = development
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(5173);

    production_origin || development_origin
}

fn external_url_is_allowed(url: &Url) -> bool {
    !has_untrusted_authority(url)
        && matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CredentialState::default())
        .manage(DesktopNotificationState::default())
        .invoke_handler(tauri::generate_handler![
            credential_store_status,
            list_stored_accounts,
            store_session_credential,
            select_stored_account,
            remove_stored_account,
            clear_stored_accounts,
            desktop_notification_status,
            request_desktop_notification_permission,
            deliver_desktop_notification
        ])
        .setup(|app| {
            let window_config = app.config().app.windows.first().ok_or_else(|| {
                std::io::Error::other("the main desktop window is not configured")
            })?;
            let opener = app.handle().clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                .on_navigation(|url| navigation_is_allowed(url, cfg!(debug_assertions)))
                .on_new_window(move |url, _features| {
                    if external_url_is_allowed(&url)
                        && opener
                            .opener()
                            .open_url(url.as_str(), None::<&str>)
                            .is_err()
                    {
                        // URLs and platform error details are deliberately not logged.
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::{external_url_is_allowed, navigation_is_allowed};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL must parse")
    }

    #[test]
    fn permits_only_application_navigation_origins() {
        assert!(navigation_is_allowed(&url("tauri://localhost/"), false));
        assert!(navigation_is_allowed(
            &url("https://tauri.localhost/community/one?space=two"),
            false
        ));
        assert!(navigation_is_allowed(
            &url("http://localhost:5173/space/one"),
            true
        ));

        for rejected in [
            "https://example.com/",
            "https://tauri.localhost.evil.test/",
            "https://user@tauri.localhost/",
            "http://localhost.evil.test:5173/",
            "http://127.0.0.1:5173/",
            "http://localhost:4173/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,unsafe",
        ] {
            assert!(
                !navigation_is_allowed(&url(rejected), true),
                "unexpectedly permitted {rejected}"
            );
        }
        assert!(!navigation_is_allowed(
            &url("http://localhost:5173/"),
            false
        ));
    }

    #[test]
    fn external_handoff_accepts_only_plain_web_urls() {
        for allowed in ["https://example.com/path", "http://example.com:8080/"] {
            assert!(external_url_is_allowed(&url(allowed)));
        }
        for rejected in [
            "https://user@example.com/",
            "file:///tmp/example",
            "javascript:alert(1)",
            "data:text/html,unsafe",
            "mailto:user@example.com",
            "nexa://space/one",
        ] {
            assert!(
                !external_url_is_allowed(&url(rejected)),
                "unexpectedly permitted {rejected}"
            );
        }
    }
}
