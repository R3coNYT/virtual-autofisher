//! Discord REST with the library's headers; 429 → rate-limit notice and one retry after `retry_after`.

use super::identity::rest_headers;
use anyhow::{anyhow, bail, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct Rest {
    http: reqwest::Client,
    base: String,
    on_rate_limit: std::sync::Arc<dyn Fn(u64) + Send + Sync>,
}

fn timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())
}

impl Rest {
    pub fn new(base: &str, token: &str, on_rate_limit: std::sync::Arc<dyn Fn(u64) + Send + Sync>) -> Result<Self> {
        let mut headers = HeaderMap::new();
        for (k, v) in rest_headers(token, &timezone()) {
            let mut value = HeaderValue::from_str(&v).map_err(|_| anyhow!("invalid header value for {k}"))?;
            if k == "authorization" {
                value.set_sensitive(true);
            }
            headers.insert(HeaderName::from_static(k), value);
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { http, base: base.trim_end_matches('/').to_string(), on_rate_limit })
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.send(|| self.http.get(format!("{}{path}", self.base))).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.send(|| self.http.post(format!("{}{path}", self.base)).json(body)).await
    }

    async fn send(&self, build: impl Fn() -> reqwest::RequestBuilder) -> Result<Value> {
        for attempt in 0..2 {
            let res = build().send().await?;
            let status = res.status();
            if status.as_u16() == 429 && attempt == 0 {
                let body: Value = res.json().await.unwrap_or(Value::Null);
                let ms = (body["retry_after"].as_f64().unwrap_or(1.0) * 1000.0).ceil() as u64;
                (self.on_rate_limit)(ms);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                continue;
            }
            if !status.is_success() {
                bail!("HTTP {} on Discord API", status.as_u16());
            }
            let text = res.text().await.unwrap_or_default();
            return Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) });
        }
        bail!("rate limited twice by Discord")
    }
}
