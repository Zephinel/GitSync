use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, MutexGuard, OnceLock};

pub use system_keyring::Error;

#[derive(Clone, Debug, Eq)]
struct CredentialKey {
    service: String,
    account: String,
}

impl CredentialKey {
    fn new(service: &str, account: &str) -> Self {
        Self {
            service: service.to_string(),
            account: account.to_string(),
        }
    }
}

impl PartialEq for CredentialKey {
    fn eq(&self, other: &Self) -> bool {
        self.service == other.service && self.account == other.account
    }
}

impl Hash for CredentialKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.service.hash(state);
        self.account.hash(state);
    }
}

#[derive(Clone, Debug)]
enum CachedCredential {
    Present(String),
    Missing,
}

static SESSION_CACHE: OnceLock<Mutex<HashMap<CredentialKey, CachedCredential>>> = OnceLock::new();
static KEYCHAIN_ACCESS_GATE: OnceLock<Mutex<()>> = OnceLock::new();

fn session_cache() -> &'static Mutex<HashMap<CredentialKey, CachedCredential>> {
    SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn keychain_access_gate() -> &'static Mutex<()> {
    KEYCHAIN_ACCESS_GATE.get_or_init(|| Mutex::new(()))
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached_result(key: &CredentialKey) -> Option<Result<String, Error>> {
    lock_recover(session_cache())
        .get(key)
        .cloned()
        .map(|cached| match cached {
            CachedCredential::Present(secret) => Ok(secret),
            CachedCredential::Missing => Err(Error::NoEntry),
        })
}

fn cache_present(key: &CredentialKey, secret: &str) {
    lock_recover(session_cache())
        .insert(key.clone(), CachedCredential::Present(secret.to_string()));
}

fn cache_missing(key: &CredentialKey) {
    lock_recover(session_cache()).insert(key.clone(), CachedCredential::Missing);
}

fn read_with_session_cache<F>(key: &CredentialKey, load: F) -> Result<String, Error>
where
    F: FnOnce() -> Result<String, Error>,
{
    if let Some(cached) = cached_result(key) {
        return cached;
    }

    // Serialize real Keychain access across the process. Besides preventing duplicate
    // reads for one item, this also prevents unrelated AI/GitHub first-use prompts from
    // racing each other and presenting multiple system dialogs at the same time.
    let _access_guard = lock_recover(keychain_access_gate());

    // Another caller may have populated the cache while this caller waited for the gate.
    if let Some(cached) = cached_result(key) {
        return cached;
    }

    match load() {
        Ok(secret) => {
            cache_present(key, &secret);
            Ok(secret)
        }
        Err(Error::NoEntry) => {
            cache_missing(key);
            Err(Error::NoEntry)
        }
        Err(error) => Err(error),
    }
}

pub struct Entry {
    key: CredentialKey,
    inner: system_keyring::Entry,
}

impl Entry {
    pub fn new(service: &str, account: &str) -> Result<Self, Error> {
        Ok(Self {
            key: CredentialKey::new(service, account),
            inner: system_keyring::Entry::new(service, account)?,
        })
    }

    pub fn get_password(&self) -> Result<String, Error> {
        read_with_session_cache(&self.key, || self.inner.get_password())
    }

    pub fn set_password(&self, password: &str) -> Result<(), Error> {
        let _access_guard = lock_recover(keychain_access_gate());
        self.inner.set_password(password)?;
        cache_present(&self.key, password);
        Ok(())
    }

    pub fn delete_credential(&self) -> Result<(), Error> {
        let _access_guard = lock_recover(keychain_access_gate());
        match self.inner.delete_credential() {
            Ok(()) => {
                cache_missing(&self.key);
                Ok(())
            }
            Err(Error::NoEntry) => {
                cache_missing(&self.key);
                Err(Error::NoEntry)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cache_missing, cache_present, read_with_session_cache, CredentialKey, Error};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    static TEST_KEY_COUNTER: AtomicUsize = AtomicUsize::new(1);

    fn unique_key(label: &str) -> CredentialKey {
        let id = TEST_KEY_COUNTER.fetch_add(1, Ordering::Relaxed);
        CredentialKey::new(
            &format!("GitSync.test.{label}.{id}"),
            &format!("account-{id}"),
        )
    }

    #[test]
    fn repeated_reads_use_the_process_session_cache() {
        let key = unique_key("repeat");
        let loads = AtomicUsize::new(0);

        let first = read_with_session_cache(&key, || {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok("secret-value".to_string())
        })
        .unwrap();
        let second = read_with_session_cache(&key, || {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok("should-not-be-read".to_string())
        })
        .unwrap();

        assert_eq!(first, "secret-value");
        assert_eq!(second, "secret-value");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_first_reads_are_single_flight() {
        let key = unique_key("single-flight");
        let loads = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let mut threads = Vec::new();

        for _ in 0..8 {
            let key = key.clone();
            let loads = Arc::clone(&loads);
            let barrier = Arc::clone(&barrier);
            threads.push(thread::spawn(move || {
                barrier.wait();
                read_with_session_cache(&key, || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(20));
                    Ok("shared-secret".to_string())
                })
                .unwrap()
            }));
        }

        for handle in threads {
            assert_eq!(handle.join().unwrap(), "shared-secret");
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_entries_are_cached_until_the_app_stores_a_value() {
        let key = unique_key("missing");
        let loads = AtomicUsize::new(0);

        let first = read_with_session_cache(&key, || {
            loads.fetch_add(1, Ordering::SeqCst);
            Err(Error::NoEntry)
        });
        assert!(matches!(first, Err(Error::NoEntry)));

        let second = read_with_session_cache(&key, || {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok("unexpected".to_string())
        });
        assert!(matches!(second, Err(Error::NoEntry)));
        assert_eq!(loads.load(Ordering::SeqCst), 1);

        cache_present(&key, "new-secret");
        let third = read_with_session_cache(&key, || Ok("unexpected".to_string())).unwrap();
        assert_eq!(third, "new-secret");

        cache_missing(&key);
        let fourth = read_with_session_cache(&key, || Ok("unexpected".to_string()));
        assert!(matches!(fourth, Err(Error::NoEntry)));
    }
}
