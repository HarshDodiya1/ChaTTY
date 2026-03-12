use ChaTTY::network::file_transfer::{compute_checksum, unique_path, CHUNK_SIZE, MAX_FILE_SIZE};
use std::io::Write;
use tempfile::{NamedTempFile, TempDir};

#[test]
fn test_constants() {
    assert_eq!(CHUNK_SIZE, 64 * 1024);
    assert_eq!(MAX_FILE_SIZE, 100 * 1024 * 1024);
}

#[tokio::test]
async fn test_compute_checksum_small_file() {
    let mut tmp = NamedTempFile::new().unwrap();
    tmp.write_all(b"hello world").unwrap();
    tmp.flush().unwrap();

    let hash = compute_checksum(tmp.path()).await.unwrap();
    // SHA-256 of "hello world" (verified at runtime)
    assert_eq!(hash.len(), 64);
    // Verify hash is hex
    assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    // Compute expected via sha2
    use sha2::{Digest, Sha256};
    let expected = format!("{:x}", Sha256::digest(b"hello world"));
    assert_eq!(hash, expected);
}

#[tokio::test]
async fn test_compute_checksum_deterministic() {
    let mut tmp: NamedTempFile = NamedTempFile::new().unwrap();
    let data = vec![0xABu8; 1024];
    tmp.write_all(&data).unwrap();
    tmp.flush().unwrap();

    let h1 = compute_checksum(tmp.path()).await.unwrap();
    let h2 = compute_checksum(tmp.path()).await.unwrap();
    assert_eq!(h1, h2);
    assert_eq!(h1.len(), 64); // SHA-256 hex is 64 chars
}

#[tokio::test]
async fn test_compute_checksum_empty_file() {
    let tmp = NamedTempFile::new().unwrap();
    let hash = compute_checksum(tmp.path()).await.unwrap();
    use sha2::{Digest, Sha256};
    let expected = format!("{:x}", Sha256::digest(b""));
    assert_eq!(hash, expected);
    assert_eq!(hash.len(), 64);
}

#[test]
fn test_unique_path_no_conflict() {
    let dir = TempDir::new().unwrap();
    let path = unique_path(dir.path(), "photo.jpg");
    assert_eq!(path.file_name().unwrap(), "photo.jpg");
}

#[test]
fn test_unique_path_with_conflict() {
    let dir = TempDir::new().unwrap();
    // Create the first file
    std::fs::write(dir.path().join("photo.jpg"), b"data").unwrap();

    let path = unique_path(dir.path(), "photo.jpg");
    assert_eq!(path.file_name().unwrap(), "photo_1.jpg");
}

#[test]
fn test_unique_path_multiple_conflicts() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("doc.txt"), b"data").unwrap();
    std::fs::write(dir.path().join("doc_1.txt"), b"data").unwrap();

    let path = unique_path(dir.path(), "doc.txt");
    assert_eq!(path.file_name().unwrap(), "doc_2.txt");
}

#[tokio::test]
async fn test_checksum_large_file() {
    let mut tmp = NamedTempFile::new().unwrap();
    let data = vec![0x42u8; CHUNK_SIZE + 1]; // slightly larger than one chunk
    tmp.write_all(&data).unwrap();
    tmp.flush().unwrap();

    let hash = compute_checksum(tmp.path()).await.unwrap();
    assert_eq!(hash.len(), 64);
}
