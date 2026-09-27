use crate::ai::limits::{MAX_PROVIDER_ERROR_CHARS, MAX_RECENT_SUBJECT_CHARS};

const SENSITIVE_ERROR_MARKERS: &[&str] = &[
    "api key",
    "api_key",
    "apikey",
    "authorization",
    "bearer ",
    "credential",
    "password",
    "private key",
    "secret",
    "token",
    "connection string",
    "sk-",
    "xoxb-",
    "ghp_",
    "glpat-",
];

const SECRET_LINE_MARKERS: &[&str] = &[
    "api_key",
    "apikey",
    "access_token",
    "auth_token",
    "authorization",
    "client_secret",
    "database_url",
    "connection_string",
    "accountkey",
    "aws_access_key_id",
    "aws_secret_access_key",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "token",
];

/// Provider error details are optional UI context, not trusted content.
/// If the message looks credential-related, discard it entirely and use the typed generic error.
pub fn sanitize_provider_error_message(value: &str) -> Option<String> {
    let normalized = normalize_single_line(value);
    let lower = normalized.to_lowercase();
    if SENSITIVE_ERROR_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return None;
    }
    let bounded = normalized
        .chars()
        .take(MAX_PROVIDER_ERROR_CHARS)
        .collect::<String>();
    (!bounded.trim().is_empty()).then_some(bounded)
}

pub fn is_sensitive_path(value: &str) -> bool {
    let normalized = value.trim().replace('\\', "/").to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let file_name = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || file_name.ends_with(".p12")
        || file_name.ends_with(".pfx")
        || file_name.ends_with(".ppk")
        || file_name.ends_with(".jks")
        || file_name.ends_with(".keystore")
        || file_name.ends_with(".tfvars")
        || file_name.ends_with(".tfvars.json")
        || file_name.starts_with("credentials")
        || file_name.starts_with("secrets")
        || file_name.starts_with("service-account")
        || file_name.starts_with("service_account")
        || file_name.starts_with("firebase-adminsdk")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || file_name == ".netrc"
        || file_name == ".vault-token"
        || file_name == "vault-token"
        || file_name == ".dockerconfigjson"
        || file_name == "auth.json"
        || file_name == "serviceaccountkey.json"
        || file_name == "google-services.json"
        || file_name.starts_with("kubeconfig")
        || normalized == ".aws/credentials"
        || normalized.ends_with("/.aws/credentials")
        || normalized == ".aws/config"
        || normalized.ends_with("/.aws/config")
        || normalized == ".kube/config"
        || normalized.ends_with("/.kube/config")
        || normalized == ".docker/config.json"
        || normalized.ends_with("/.docker/config.json")
        || normalized.ends_with("/.npmrc")
        || normalized.ends_with("/.pypirc")
        || normalized == ".npmrc"
        || normalized == ".pypirc"
}

pub fn sanitize_commit_subject(value: &str) -> Option<String> {
    let normalized = normalize_single_line(value);
    if normalized.is_empty() || looks_secret_like(&normalized.to_lowercase()) {
        return None;
    }
    Some(
        normalized
            .chars()
            .take(MAX_RECENT_SUBJECT_CHARS)
            .collect::<String>(),
    )
}

/// Redacts complete diff lines when they contain high-confidence credential material.
/// The diff prefix is retained so the model can still understand whether the line was added or removed.
pub fn sanitize_diff_content(value: &str) -> (String, u32) {
    let mut redacted_count = 0_u32;
    let mut in_private_key = false;
    let mut output = String::with_capacity(value.len().min(128 * 1024));

    for raw_line in value.lines() {
        let (prefix, body) = split_diff_prefix(raw_line);
        let lower = body.to_lowercase();
        let starts_private_key =
            lower.contains("-----begin ") && lower.contains("private key-----");
        let ends_private_key = lower.contains("-----end ") && lower.contains("private key-----");
        let should_redact = in_private_key
            || starts_private_key
            || looks_secret_like(&lower)
            || looks_like_secret_assignment(&lower)
            || looks_like_credential_url(&lower);

        if should_redact {
            redacted_count = redacted_count.saturating_add(1);
            output.push_str(prefix);
            output.push_str("[REDACTED SECRET-LIKE CONTENT]");
        } else {
            output.push_str(raw_line);
        }
        output.push('\n');

        if starts_private_key {
            in_private_key = true;
        }
        if ends_private_key {
            in_private_key = false;
        }
    }

    (output, redacted_count)
}

fn normalize_single_line(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\r' | '\n' | '\t' => ' ',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_diff_prefix(line: &str) -> (&str, &str) {
    if line.starts_with("+++") || line.starts_with("---") {
        return ("", line);
    }
    match line.as_bytes().first().copied() {
        Some(b'+') => ("+", &line[1..]),
        Some(b'-') => ("-", &line[1..]),
        Some(b' ') => (" ", &line[1..]),
        _ => ("", line),
    }
}

fn looks_secret_like(lower: &str) -> bool {
    lower.contains("authorization: bearer ")
        || lower.contains("bearer eyj")
        || lower.contains("github_pat_")
        || lower.contains("ghp_")
        || lower.contains("gho_")
        || lower.contains("ghu_")
        || lower.contains("ghs_")
        || lower.contains("ghr_")
        || lower.contains("glpat-")
        || lower.contains("xoxb-")
        || lower.contains("xoxp-")
        || lower.contains("xoxa-")
        || lower.contains("sk-proj-")
        || lower.contains("sk-live-")
        || lower.contains("sk_test_")
        || lower.contains("sk_live_")
        || lower.contains("rk_live_")
        || lower.contains("npm_")
        || lower.contains("hf_")
        || lower.contains("aiza")
        || lower.contains("-----begin ") && lower.contains("private key-----")
        || contains_aws_access_key(lower)
}

fn contains_aws_access_key(lower: &str) -> bool {
    lower
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| {
            part.len() == 20
                && (part.starts_with("akia") || part.starts_with("asia"))
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
}

fn looks_like_secret_assignment(lower: &str) -> bool {
    SECRET_LINE_MARKERS.iter().any(|marker| {
        lower.find(marker).is_some_and(|index| {
            let tail = &lower[index + marker.len()..];
            let trimmed = tail.trim_start_matches(|character: char| {
                character.is_ascii_whitespace() || matches!(character, '"' | '\'' | ']' | ')' | '-')
            });
            trimmed.starts_with('=') || trimmed.starts_with(':')
        })
    })
}

fn looks_like_credential_url(lower: &str) -> bool {
    [
        "postgres://",
        "postgresql://",
        "mysql://",
        "mongodb://",
        "mongodb+srv://",
        "redis://",
        "amqp://",
    ]
    .iter()
    .any(|scheme| {
        lower.find(scheme).is_some_and(|index| {
            let authority = &lower[index + scheme.len()..];
            authority
                .split(|character| matches!(character, '/' | '?' | '#'))
                .next()
                .is_some_and(|value| value.contains(':') && value.contains('@'))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        is_sensitive_path, sanitize_commit_subject, sanitize_diff_content,
        sanitize_provider_error_message,
    };

    #[test]
    fn normalizes_and_bounds_safe_provider_errors() {
        assert_eq!(
            sanitize_provider_error_message("bad\nrequest").as_deref(),
            Some("bad request")
        );
        let long = "x".repeat(800);
        assert_eq!(
            sanitize_provider_error_message(&long)
                .unwrap()
                .chars()
                .count(),
            400
        );
    }

    #[test]
    fn drops_secret_like_provider_errors() {
        for value in [
            "invalid api key sk-example",
            "Authorization: Bearer abc",
            "token expired",
            "password rejected",
            "connection string contains credentials",
        ] {
            assert_eq!(sanitize_provider_error_message(value), None);
        }
    }

    #[test]
    fn blocks_expanded_sensitive_paths_without_blocking_normal_sources() {
        for path in [
            ".env",
            ".env.local",
            "certs/server.pem",
            "keys/id_ed25519",
            ".aws/credentials",
            "config/secrets-prod.json",
            ".docker/config.json",
            ".kube/config",
            "android/release.keystore",
            "infra/prod.tfvars",
            "service-account-prod.json",
            ".netrc",
        ] {
            assert!(is_sensitive_path(path), "expected sensitive path: {path}");
        }
        assert!(!is_sensitive_path("src/provider.rs"));
        assert!(!is_sensitive_path("docs/tokenization.md"));
        assert!(!is_sensitive_path("src/key_store.rs"));
    }

    #[test]
    fn redacts_assignments_private_keys_vendor_tokens_and_credential_urls() {
        let (sanitized, count) = sanitize_diff_content(
            "+const API_KEY = \"sk-proj-secret\";\n+SLACK=xoxb-secret\n+AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\n+DATABASE_URL=postgres://user:password@db.example/app\n+-----BEGIN PRIVATE KEY-----\n+abc\n+-----END PRIVATE KEY-----\n+safe = true\n",
        );
        assert_eq!(count, 7);
        assert!(!sanitized.contains("sk-proj-secret"));
        assert!(!sanitized.contains("xoxb-secret"));
        assert!(!sanitized.contains("AKIA1234567890ABCDEF"));
        assert!(!sanitized.contains("user:password"));
        assert!(!sanitized.contains("abc"));
        assert!(sanitized.contains("+safe = true"));
    }

    #[test]
    fn drops_secret_like_recent_subjects() {
        assert_eq!(
            sanitize_commit_subject("fix: normal subject").as_deref(),
            Some("fix: normal subject")
        );
        assert_eq!(sanitize_commit_subject("chore: rotate ghp_secret"), None);
        assert_eq!(sanitize_commit_subject("chore: rotate xoxb-secret"), None);
    }
}
