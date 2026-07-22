fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "credential_store_status",
            "list_stored_accounts",
            "store_session_credential",
            "select_stored_account",
            "remove_stored_account",
            "clear_stored_accounts",
        ]),
    ))
    .expect("failed to prepare desktop build metadata");
}
