mod selected_git_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    struct SelectedRepo {
        path: PathBuf,
    }

    impl SelectedRepo {
        fn new(label: &str) -> Self {
            let path = stash_test_repo_path("gitsync-selected-stash", label);
            fs::create_dir(&path).expect("create selected stash repository");
            git(&path, &["init", "--quiet"]);
            git(&path, &["config", "user.name", "GitSync Test"]);
            git(
                &path,
                &["config", "user.email", "gitsync-test@example.invalid"],
            );
            fs::write(path.join("a.txt"), "a-base\n").unwrap();
            fs::write(path.join("b.txt"), "b-base\n").unwrap();
            git(&path, &["add", "--", "a.txt", "b.txt"]);
            git(&path, &["commit", "--quiet", "-m", "initial"]);
            Self { path }
        }
    }

    impl Drop for SelectedRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        // Porcelain/short status uses leading columns as semantic data. Only strip
        // trailing line endings so ` M path` and `M  path` remain distinguishable.
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string()
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn literal_pathspec_keeps_backslash_slash_and_space_prefixed_paths_distinct() {
        let repo = SelectedRepo::new("path-identity");
        fs::create_dir_all(repo.path.join("dir")).unwrap();
        fs::write(repo.path.join("dir\\file.txt"), "backslash base\n").unwrap();
        fs::write(repo.path.join("dir/file.txt"), "slash base\n").unwrap();
        fs::write(repo.path.join(" file.txt"), "leading base\n").unwrap();
        fs::write(repo.path.join("file.txt"), "normal base\n").unwrap();
        git(
            &repo.path,
            &[
                "add",
                "--",
                ":(literal)dir\\file.txt",
                ":(literal)dir/file.txt",
                ":(literal) file.txt",
                ":(literal)file.txt",
            ],
        );
        git(&repo.path, &["commit", "--quiet", "-m", "identity baseline"]);

        fs::write(repo.path.join("dir\\file.txt"), "backslash selected\n").unwrap();
        fs::write(repo.path.join("dir/file.txt"), "slash untouched\n").unwrap();
        fs::write(repo.path.join(" file.txt"), "leading selected\n").unwrap();
        fs::write(repo.path.join("file.txt"), "normal untouched\n").unwrap();

        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--message",
                "identity selected",
                "--",
                ":(literal)dir\\file.txt",
                ":(literal) file.txt",
            ],
        );

        assert_eq!(
            fs::read_to_string(repo.path.join("dir\\file.txt")).unwrap(),
            "backslash base\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path.join("dir/file.txt")).unwrap(),
            "slash untouched\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path.join(" file.txt")).unwrap(),
            "leading base\n"
        );
        assert_eq!(
            fs::read_to_string(repo.path.join("file.txt")).unwrap(),
            "normal untouched\n"
        );
        let status = git(&repo.path, &["status", "--porcelain=v1", "-z"]);
        assert!(!status.contains("dir\\file.txt"));
        assert!(status.contains("dir/file.txt"));
        assert!(!status.contains(" M  file.txt\0"));
        assert!(status.contains(" M file.txt\0"));
    }

    #[test]
    fn pathspec_stashes_only_the_selected_tracked_file() {
        let repo = SelectedRepo::new("tracked");
        fs::write(repo.path.join("a.txt"), "a-selected\n").unwrap();
        fs::write(repo.path.join("b.txt"), "b-untouched\n").unwrap();

        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--message",
                "selected",
                "--",
                ":(literal)a.txt",
            ],
        );

        assert_eq!(fs::read_to_string(repo.path.join("a.txt")).unwrap(), "a-base\n");
        assert_eq!(
            fs::read_to_string(repo.path.join("b.txt")).unwrap(),
            "b-untouched\n"
        );
        assert_eq!(git(&repo.path, &["status", "--short"]), " M b.txt");
    }

    #[test]
    fn selected_untracked_scope_leaves_other_untracked_files_untouched() {
        let repo = SelectedRepo::new("untracked");
        fs::write(repo.path.join("selected.txt"), "selected\n").unwrap();
        fs::write(repo.path.join("other.txt"), "other\n").unwrap();

        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--include-untracked",
                "--message",
                "selected-untracked",
                "--",
                ":(literal)selected.txt",
            ],
        );

        assert!(!repo.path.join("selected.txt").exists());
        assert!(repo.path.join("other.txt").exists());
        assert_eq!(git(&repo.path, &["status", "--short"]), "?? other.txt");
    }

    #[test]
    fn selected_keep_index_preserves_staged_content_and_other_files() {
        let repo = SelectedRepo::new("keep-index");
        fs::write(repo.path.join("a.txt"), "a-staged\n").unwrap();
        git(&repo.path, &["add", "--", "a.txt"]);
        fs::write(repo.path.join("a.txt"), "a-unstaged\n").unwrap();
        fs::write(repo.path.join("b.txt"), "b-untouched\n").unwrap();

        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--keep-index",
                "--message",
                "selected-keep-index",
                "--",
                ":(literal)a.txt",
            ],
        );

        assert_eq!(fs::read_to_string(repo.path.join("a.txt")).unwrap(), "a-staged\n");
        assert_eq!(
            fs::read_to_string(repo.path.join("b.txt")).unwrap(),
            "b-untouched\n"
        );
        let status = git(&repo.path, &["status", "--short"]);
        assert!(status.lines().any(|line| line == "M  a.txt"));
        assert!(status.lines().any(|line| line == " M b.txt"));
    }
}
