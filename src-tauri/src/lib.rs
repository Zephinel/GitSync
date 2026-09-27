extern crate self as keyring;

mod ai;
mod app_restart_guard;
mod branch_creation;
mod branch_delete;
mod branch_management;
mod commands;
mod commit_diff;
mod credential_broker;
mod git_atomic_mutation;
mod git_command;
#[path = "git_content_authority_runtime.rs"]
mod git_content_authority;
mod git_encoding;
mod git_timeouts;
mod image_diff;
mod repo_git_lock;
#[path = "staging_authority.rs"]
mod staging;
mod stash;
mod window_lifecycle_diagnostics;
mod window_scale_guard;
mod window_state;
#[path = "working_changes_authority.rs"]
mod working_changes;

pub use credential_broker::{Entry, Error};

use tauri::Manager;

pub fn run() {
    let state = commands::AppState::new();

    let builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .setup(|app| {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let app_data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            let state = app.state::<commands::AppState>();
            state.init(app_data_dir.clone());
            window_state::setup_main_window_state(app, &app_data_dir);
            if window_lifecycle_diagnostics::is_enabled() {
                window_lifecycle_diagnostics::setup_window_lifecycle_diagnostics(
                    app,
                    &app_data_dir,
                );
            }
            window_scale_guard::setup_window_scale_guard(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::is_git_repo,
            commands::get_app_restart_blockers,
            commands::acquire_app_restart_guard,
            commands::release_app_restart_guard,
            commands::open_repo_directory,
            commands::open_repo_directory_with_app,
            commands::get_repo_status,
            commands::refresh_repo_remote,
            commands::get_repo_branch_overview,
            commands::switch_repo_branch,
            commands::switch_and_update_repo_branch,
            commands::rebind_repo_branch_upstream,
            commands::unset_repo_branch_upstream,
            branch_management::get_repo_branch_management_meta,
            branch_management::sync_repo_branch,
            branch_creation::inspect_repo_branch_creation,
            branch_creation::validate_repo_branch_creation_name,
            branch_creation::execute_repo_branch_creation,
            branch_creation::reconcile_repo_branch_creation,
            branch_creation::resume_repo_branch_creation,
            branch_delete::delete_repo_branches_batch,
            commands::refresh_repo_git_metadata,
            commands::get_repos,
            commands::add_repo,
            commands::clone_repo,
            commands::cancel_clone_task,
            commands::remove_repo,
            commands::remove_repos_batch,
            commands::restore_repos,
            commands::check_sync_prerequisites,
            commands::update_repo,
            commands::update_repos_batch,
            commands::sync_repo,
            commands::run_repo_build_script,
            commands::resolve_conflict,
            commands::resolve_all_conflicts,
            commands::abort_merge,
            commands::get_conflict_files,
            commands::get_log,
            commands::get_repo_commit_history,
            commit_diff::get_repo_commit_diff_summary,
            commit_diff::get_repo_commit_file_diff,
            image_diff::get_repo_commit_image_diff_preview,
            working_changes::get_repo_working_diff_summary,
            working_changes::get_repo_working_file_diff,
            image_diff::get_repo_working_image_diff_preview,
            working_changes::discard_repo_working_files,
            working_changes::discard_repo_working_files_unstaged,
            working_changes::commit_repo_working_files,
            staging::get_repo_staging_snapshot,
            staging::stage_repo_files,
            staging::unstage_repo_files,
            stash::authoritative_snapshot::get_repo_stash_snapshot,
            stash::authoritative_detail::get_repo_stash_detail,
            stash::authoritative_detail::get_repo_stash_file_diff,
            stash::authoritative_create::create_repo_stash,
            stash::authoritative_selected_create::create_repo_stash_selected_authoritative,
            stash::authoritative_restore::apply_repo_stash,
            stash::authoritative_restore::pop_repo_stash,
            stash::authoritative_drop::drop_repo_stash,
            stash::authoritative_reconcile::reconcile_repo_stash_operation,
            stash::authoritative_acknowledge::acknowledge_repo_stash_operation,
            ai::commands::get_ai_configuration_status,
            ai::commands::save_ai_configuration,
            ai::commands::set_ai_api_key,
            ai::commands::clear_ai_api_key,
            ai::commands::list_ai_models,
            ai::commands::test_ai_connection,
            ai::commands::generate_ai_commit_message,
            ai::branch_name::generate_ai_branch_names,
            ai::branch_name::cancel_ai_branch_name_request,
            ai::review_commands::preview_ai_review_scope,
            ai::review_commands::run_ai_review,
            ai::review_commands::cancel_ai_review_request,
            ai::review_status::get_ai_review_scope_fingerprint,
            ai::commands::cancel_ai_request,
            commands::github_start_device_auth,
            commands::github_poll_token,
            commands::github_cancel_device_auth,
            commands::github_get_account,
            commands::github_get_repos,
            commands::github_logout,
            commands::write_clipboard,
            window_lifecycle_diagnostics::record_webview_diagnostics,
            window_lifecycle_diagnostics::is_window_diagnostics_enabled,
            window_scale_guard::webview_scale_guard,
            window_scale_guard::is_window_scale_guard_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
