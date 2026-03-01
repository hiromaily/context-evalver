/// Smoke tests verifying the binary crate compiles and core dependencies are accessible.
/// These run before any domain logic exists — establishing the baseline build health.

#[test]
fn rusqlite_opens_in_memory_database() {
    // Verifies the rusqlite (bundled) dependency links correctly.
    let conn = rusqlite::Connection::open_in_memory()
        .expect("rusqlite should open an in-memory database");
    let result: i64 = conn
        .query_row("SELECT 1", [], |row| row.get(0))
        .expect("trivial query should succeed");
    assert_eq!(result, 1);
}

#[test]
fn serde_json_round_trips_a_value() {
    // Verifies serde + serde_json derive macros are available and functional.
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Ping {
        value: u64,
    }

    let original = Ping { value: 42 };
    let json = serde_json::to_string(&original).expect("serialization should succeed");
    let decoded: Ping = serde_json::from_str(&json).expect("deserialization should succeed");
    assert_eq!(original, decoded);
}

#[test]
fn xxhash_produces_stable_digest() {
    // Verifies xxhash-rust (xxh3 feature) is available and produces deterministic output.
    use xxhash_rust::xxh3::xxh3_64;

    let hash_a = xxh3_64(b"context-optimizer");
    let hash_b = xxh3_64(b"context-optimizer");
    assert_eq!(hash_a, hash_b, "identical input must produce identical hash");

    let hash_other = xxh3_64(b"different-input");
    assert_ne!(hash_a, hash_other, "different input must produce different hash");
}

#[test]
fn anyhow_error_propagation_compiles() {
    // Verifies the anyhow dependency is linked and basic error propagation works.
    fn fallible() -> anyhow::Result<u32> {
        Ok(7)
    }
    assert_eq!(fallible().unwrap(), 7);
}
