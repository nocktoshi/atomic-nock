//! In-memory key/value store. Port of `MemoryKvStore` — the dev fallback when no
//! KV worker is configured, and the test backing store. Not durable.

use std::collections::HashMap;
use std::sync::Mutex;

/// Async KV abstraction (mirrors the TS `KvStore`).
#[allow(async_fn_in_trait)]
pub trait Kv {
    async fn get(&self, key: &str) -> Option<String>;
    async fn put(&self, key: &str, value: &str);
    async fn delete(&self, key: &str);
    async fn list(&self, prefix: &str) -> Vec<String>;
}

#[derive(Default)]
pub struct MemoryKv {
    map: Mutex<HashMap<String, String>>,
}

impl MemoryKv {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Kv for MemoryKv {
    async fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }
    async fn put(&self, key: &str, value: &str) {
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
    }
    async fn delete(&self, key: &str) {
        self.map.lock().unwrap().remove(key);
    }
    async fn list(&self, prefix: &str) -> Vec<String> {
        self.map
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }
}
