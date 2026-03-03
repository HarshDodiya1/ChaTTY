use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng as AeadRng},
    Aes256Gcm, Key, Nonce,
};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

// ── Key persistence ────────────────────────────────────────────────────────

/// Load the local X25519 static key from disk, or generate and save a new one.
pub fn load_or_generate_keypair(data_dir: &Path) -> Result<(StaticSecret, PublicKey)> {
    let key_path = data_dir.join("private.key");

    let secret = if key_path.exists() {
        let bytes = fs::read(&key_path)
            .with_context(|| format!("Failed to read private key: {}", key_path.display()))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("private.key must be exactly 32 bytes"))?;
        StaticSecret::from(arr)
    } else {
        let secret = StaticSecret::random_from_rng(rand::thread_rng());
        let raw: [u8; 32] = secret.to_bytes();
        fs::create_dir_all(data_dir)
            .with_context(|| format!("Failed to create data dir: {}", data_dir.display()))?;
        fs::write(&key_path, raw)
            .with_context(|| format!("Failed to write private key: {}", key_path.display()))?;

        // chmod 600 on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))
                .with_context(|| "Failed to set permissions on private.key")?;
        }

        secret
    };

    let public = PublicKey::from(&secret);
    Ok((secret, public))
}

// ── Per-peer session ────────────────────────────────────────────────────────

/// A symmetric AES-256-GCM session key derived from an X25519 DH exchange.
#[derive(Clone)]
pub struct SessionKey {
    key: [u8; 32],
}

impl SessionKey {
    /// Derive a session key from `my_secret` and `their_public_key_bytes`.
    pub fn from_dh(my_secret: &StaticSecret, their_public_key_bytes: &[u8]) -> Result<Self> {
        let arr: [u8; 32] = their_public_key_bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Peer public key must be 32 bytes"))?;
        let their_public = PublicKey::from(arr);
        let shared = my_secret.diffie_hellman(&their_public);

        // Derive AES-256 key from shared secret via SHA-256
        let key_bytes: [u8; 32] = Sha256::digest(shared.as_bytes()).into();
        Ok(SessionKey { key: key_bytes })
    }

    /// Encrypt `plaintext` → `nonce || ciphertext` (nonce prepended).
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let nonce = Aes256Gcm::generate_nonce(&mut AeadRng);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Decrypt `nonce || ciphertext` → plaintext.
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        if data.len() < 12 {
            anyhow::bail!("Encrypted payload too short (< 12 bytes)");
        }
        let (nonce_bytes, ciphertext) = data.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))
    }
}

// ── Session registry ────────────────────────────────────────────────────────

/// Maps peer_id → SessionKey. Held in memory only (never persisted).
#[derive(Default)]
pub struct SessionRegistry {
    sessions: HashMap<String, SessionKey>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        SessionRegistry::default()
    }

    pub fn insert(&mut self, peer_id: String, key: SessionKey) {
        self.sessions.insert(peer_id, key);
    }

    pub fn get(&self, peer_id: &str) -> Option<&SessionKey> {
        self.sessions.get(peer_id)
    }

    pub fn remove(&mut self, peer_id: &str) {
        self.sessions.remove(peer_id);
    }

    pub fn is_encrypted(&self, peer_id: &str) -> bool {
        self.sessions.contains_key(peer_id)
    }
}

// ── Ephemeral key exchange helper ───────────────────────────────────────────

/// Generate an ephemeral keypair for the Hello/HelloAck handshake.
pub fn ephemeral_keypair() -> (EphemeralSecret, PublicKey) {
    let secret = EphemeralSecret::random_from_rng(rand::thread_rng());
    let public = PublicKey::from(&secret);
    (secret, public)
}

/// Derive a SessionKey from an ephemeral secret + peer's public key bytes.
pub fn session_from_ephemeral(
    my_secret: EphemeralSecret,
    their_public_bytes: &[u8],
) -> Result<SessionKey> {
    let arr: [u8; 32] = their_public_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Peer public key must be 32 bytes"))?;
    let their_public = PublicKey::from(arr);
    let shared = my_secret.diffie_hellman(&their_public);
    let key_bytes: [u8; 32] = Sha256::digest(shared.as_bytes()).into();
    Ok(SessionKey { key: key_bytes })
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use x25519_dalek::StaticSecret;

    fn make_static_pair() -> (StaticSecret, PublicKey) {
        let secret = StaticSecret::random_from_rng(rand::thread_rng());
        let public = PublicKey::from(&secret);
        (secret, public)
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let (a_secret, a_public) = make_static_pair();
        let (_b_secret, b_public) = make_static_pair();

        let session = SessionKey::from_dh(&a_secret, b_public.as_bytes()).unwrap();
        let plaintext = b"Hello, encrypted world!";
        let ciphertext = session.encrypt(plaintext).unwrap();
        let decrypted = session.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
        let _ = a_public;
    }

    #[test]
    fn test_encrypt_different_nonce_each_time() {
        let (a_secret, _) = make_static_pair();
        let (_, b_public) = make_static_pair();
        let session = SessionKey::from_dh(&a_secret, b_public.as_bytes()).unwrap();

        let c1 = session.encrypt(b"test").unwrap();
        let c2 = session.encrypt(b"test").unwrap();
        // Different nonces → different ciphertexts
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let (a_secret, _) = make_static_pair();
        let (_, b_public) = make_static_pair();
        let (c_secret, _) = make_static_pair();
        let (_, d_public) = make_static_pair();

        let session_a = SessionKey::from_dh(&a_secret, b_public.as_bytes()).unwrap();
        let session_c = SessionKey::from_dh(&c_secret, d_public.as_bytes()).unwrap();

        let ciphertext = session_a.encrypt(b"secret").unwrap();
        assert!(session_c.decrypt(&ciphertext).is_err());
    }

    #[test]
    fn test_dh_symmetric() {
        // Two peers compute the same session key via DH
        let (alice_secret, alice_public) = make_static_pair();
        let (bob_secret, bob_public) = make_static_pair();

        let alice_session = SessionKey::from_dh(&alice_secret, bob_public.as_bytes()).unwrap();
        let bob_session = SessionKey::from_dh(&bob_secret, alice_public.as_bytes()).unwrap();

        let msg = b"DH symmetric test";
        let enc = alice_session.encrypt(msg).unwrap();
        let dec = bob_session.decrypt(&enc).unwrap();
        assert_eq!(dec, msg);
    }

    #[test]
    fn test_decrypt_truncated_fails() {
        let (a_secret, _) = make_static_pair();
        let (_, b_public) = make_static_pair();
        let session = SessionKey::from_dh(&a_secret, b_public.as_bytes()).unwrap();
        assert!(session.decrypt(&[0u8; 5]).is_err());
    }

    #[test]
    fn test_session_registry() {
        let mut registry = SessionRegistry::new();
        let (a_secret, _) = make_static_pair();
        let (_, b_public) = make_static_pair();
        let key = SessionKey::from_dh(&a_secret, b_public.as_bytes()).unwrap();

        assert!(!registry.is_encrypted("peer1"));
        registry.insert("peer1".to_string(), key);
        assert!(registry.is_encrypted("peer1"));
        registry.remove("peer1");
        assert!(!registry.is_encrypted("peer1"));
    }

    #[test]
    fn test_keypair_persistence() {
        // Tested via load_or_generate_keypair — covered in integration context.
        // Inline test uses a tempdir-style approach.
        let dir = std::env::temp_dir().join(format!("chattyCryptoTest_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (_s1, p1) = load_or_generate_keypair(&dir).unwrap();
        let (_s2, p2) = load_or_generate_keypair(&dir).unwrap();
        // Same key loaded both times
        assert_eq!(p1.as_bytes(), p2.as_bytes());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
