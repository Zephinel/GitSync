use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::fs::File;
use std::io::Read;

fn verify(public_key_b64: &str, bundle_path: &str, signature_path: &str) -> Result<(), String> {
    let public_key_text = STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("invalid updater public key encoding: {e}"))?;
    let public_key_text = String::from_utf8(public_key_text)
        .map_err(|e| format!("invalid updater public key text: {e}"))?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|e| format!("invalid updater public key: {e}"))?;

    let signature_b64 = std::fs::read_to_string(signature_path)
        .map_err(|e| format!("cannot read updater signature: {e}"))?;
    let signature_text = STANDARD
        .decode(signature_b64.trim())
        .map_err(|e| format!("invalid updater signature encoding: {e}"))?;
    let signature_text = String::from_utf8(signature_text)
        .map_err(|e| format!("invalid updater signature text: {e}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|e| format!("invalid updater signature: {e}"))?;

    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|e| format!("updater signature does not match public key: {e}"))?;
    let mut bundle =
        File::open(bundle_path).map_err(|e| format!("cannot read updater bundle: {e}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = bundle
            .read(&mut buffer)
            .map_err(|e| format!("cannot read updater bundle: {e}"))?;
        if size == 0 {
            break;
        }
        verifier.update(&buffer[..size]);
    }
    verifier
        .finalize()
        .map_err(|e| format!("updater signature verification failed: {e}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!(
            "usage: gitsync-updater-signature-verifier <public-key-base64> <bundle> <signature>"
        );
        std::process::exit(2);
    }
    if let Err(error) = verify(&args[1], &args[2], &args[3]) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::verify;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn verifies_bundle_bytes_and_rejects_a_modified_bundle() {
        // Public prehashed Minisign test vector from minisign-verify 0.2.5.
        let public_key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        let directory = std::env::temp_dir().join(format!(
            "gitsync-updater-signature-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let bundle = directory.join("bundle");
        let signature_file = directory.join("bundle.sig");
        std::fs::write(&bundle, b"test").unwrap();
        std::fs::write(&signature_file, STANDARD.encode(signature)).unwrap();
        let public_key_b64 = STANDARD.encode(public_key);
        let bundle_path = bundle.to_str().unwrap();
        let signature_path = signature_file.to_str().unwrap();
        assert!(verify(&public_key_b64, bundle_path, signature_path).is_ok());
        std::fs::write(&bundle, b"Test").unwrap();
        assert!(verify(&public_key_b64, bundle_path, signature_path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
