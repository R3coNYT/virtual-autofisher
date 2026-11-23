//! How the client presents itself to Discord: copied from discord.js-selfbot-v13 3.7.1
//! (`src/util/Options.js` ws.properties, `src/util/Constants.js` UserAgent, `src/rest/APIRequest.js`
//! headers) so 2.0 looks exactly like 1.x on the wire. Refresh these values here when Discord updates.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9210 Chrome/134.0.6998.205 Electron/35.3.0 Safari/537.36";
pub const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=9&encoding=json";
pub const API_BASE: &str = "https://discord.com/api/v9";

/// The `properties` object, with per-launch random ids (generated once per process, like the library).
pub fn super_properties() -> Value {
    static IDS: OnceLock<(String, String, String)> = OnceLock::new();
    let (launch_id, signature, heartbeat_session) = IDS.get_or_init(|| {
        (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string())
    });
    json!({
        "os": "Windows",
        "browser": "Discord Client",
        "release_channel": "stable",
        "client_version": "1.0.9210",
        "os_version": "10.0.19044",
        "os_arch": "x64",
        "app_arch": "x64",
        "system_locale": "en-US",
        "has_client_mods": false,
        "client_launch_id": launch_id,
        "browser_user_agent": USER_AGENT,
        "browser_version": "35.3.0",
        "os_sdk_version": "19044",
        "client_build_number": 455964,
        "native_build_number": 69976,
        "client_event_source": null,
        "launch_signature": signature,
        "client_heartbeat_session_id": heartbeat_session,
        "client_app_state": "focused"
    })
}

pub fn super_properties_b64() -> String {
    STANDARD.encode(super_properties().to_string())
}

/// Gateway op 2 payload (`d`), as the library sends it.
pub fn identify_payload(token: &str) -> Value {
    json!({
        "token": token,
        "capabilities": 0,
        "properties": super_properties(),
        "compress": false,
        "client_state": { "guild_versions": {} }
    })
}

/// REST headers, as the library sends them. `timezone` is the IANA zone (e.g. "Europe/Paris").
pub fn rest_headers(token: &str, timezone: &str) -> Vec<(&'static str, String)> {
    vec![
        ("accept", "*/*".into()),
        ("accept-language", "en-US".into()),
        ("priority", "u=1, i".into()),
        ("referer", "https://discord.com/channels/@me".into()),
        ("sec-ch-ua", "\"Not:A-Brand\";v=\"24\", \"Chromium\";v=\"134\"".into()),
        ("sec-ch-ua-mobile", "?0".into()),
        ("sec-ch-ua-platform", "\"Windows\"".into()),
        ("sec-fetch-dest", "empty".into()),
        ("sec-fetch-mode", "cors".into()),
        ("sec-fetch-site", "same-origin".into()),
        ("x-discord-locale", "en-US".into()),
        ("x-discord-timezone", timezone.into()),
        ("x-super-properties", super_properties_b64()),
        ("origin", "https://discord.com".into()),
        ("x-debug-options", "bugReporterEnabled".into()),
        ("user-agent", USER_AGENT.into()),
        ("authorization", token.into()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identify_has_library_properties() {
        let d = identify_payload("tok");
        assert_eq!(d["capabilities"], 0);
        assert_eq!(d["compress"], false);
        assert_eq!(d["client_state"], json!({ "guild_versions": {} }));
        let p = &d["properties"];
        assert_eq!(p["os"], "Windows");
        assert_eq!(p["browser"], "Discord Client");
        assert_eq!(p["client_build_number"], 455964);
        assert_eq!(p["browser_user_agent"], USER_AGENT);
        assert_eq!(super_properties()["client_launch_id"], p["client_launch_id"]); // stable per launch
    }

    #[test]
    fn rest_headers_carry_super_properties_and_raw_token() {
        let h = rest_headers("abc.def.ghi", "Europe/Paris");
        let get = |k: &str| h.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("authorization"), "abc.def.ghi");
        let decoded: Value = serde_json::from_slice(&STANDARD.decode(get("x-super-properties")).unwrap()).unwrap();
        assert_eq!(decoded["os"], "Windows");
        assert_eq!(get("x-discord-timezone"), "Europe/Paris");
    }
}
