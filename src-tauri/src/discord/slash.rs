//! Slash commands: positional option order and the `POST /interactions` body (as the library builds it).

use crate::model::{SlashCommandInfo, SlashOptions};
use anyhow::{bail, Result};
use serde_json::{json, Value};

const DISCORD_EPOCH_MS: i64 = 1_420_070_400_000;

/// Values in `info.options` order up to the last provided one; unset options before it are gaps (None).
pub fn order_slash_args(info: &SlashCommandInfo, options: &SlashOptions) -> Result<Vec<Option<Value>>> {
    for name in options.keys() {
        if !info.options.iter().any(|o| &o.name == name) {
            bail!("Unknown option: {name}");
        }
    }
    let last = info.options.iter().rposition(|o| options.contains_key(&o.name));
    Ok(match last {
        Some(last) => info.options[..=last].iter().map(|o| options.get(&o.name).cloned()).collect(),
        None => vec![],
    })
}

/// A snowflake for `now_ms` (used as the interaction nonce).
pub fn nonce(now_ms: i64) -> String {
    (((now_ms - DISCORD_EPOCH_MS).max(0) as u64) << 22).to_string()
}

/// `POST /interactions` body for an application command (type 2), gaps omitted.
pub fn interaction_payload(
    cmd: &SlashCommandInfo,
    app_id: &str,
    guild_id: &str,
    channel_id: &str,
    session_id: &str,
    nonce: &str,
    options: &SlashOptions,
) -> Result<Value> {
    let ordered = order_slash_args(cmd, options)?;
    let opts: Vec<Value> = cmd
        .options
        .iter()
        .zip(ordered)
        .filter_map(|(o, v)| v.map(|value| json!({ "type": o.kind, "name": o.name, "value": value })))
        .collect();
    Ok(json!({
        "type": 2,
        "application_id": app_id,
        "guild_id": guild_id,
        "channel_id": channel_id,
        "session_id": session_id,
        "nonce": nonce,
        "data": {
            "version": cmd.version,
            "id": cmd.id,
            "name": cmd.name,
            "type": 1,
            "options": opts,
            "attachments": []
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SlashOption;

    fn cmd() -> SlashCommandInfo {
        let o = |n: &str, k: u8| SlashOption { name: n.into(), kind: k, ..SlashOption::default() };
        SlashCommandInfo { name: "buy".into(), id: "10".into(), version: "20".into(), options: vec![o("item", 3), o("amount", 4), o("note", 3)] }
    }
    fn opts(pairs: &[(&str, Value)]) -> SlashOptions {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn keeps_a_gap_before_a_provided_option() {
        assert_eq!(order_slash_args(&cmd(), &opts(&[("amount", json!(5))])).unwrap(), vec![None, Some(json!(5))]);
    }

    #[test]
    fn trims_trailing_unset_options_and_orders_by_command() {
        let r = order_slash_args(&cmd(), &opts(&[("amount", json!(2)), ("item", json!("fish5m"))])).unwrap();
        assert_eq!(r, vec![Some(json!("fish5m")), Some(json!(2))]);
        assert!(order_slash_args(&cmd(), &SlashOptions::new()).unwrap().is_empty());
    }

    #[test]
    fn throws_on_an_unknown_option() {
        let e = order_slash_args(&cmd(), &opts(&[("nope", json!(1))])).unwrap_err();
        assert_eq!(e.to_string(), "Unknown option: nope");
    }

    #[test]
    fn payload_matches_library_shape() {
        let p = interaction_payload(&cmd(), "app", "g", "c", "sess", "n1", &opts(&[("item", json!("fish5m")), ("amount", json!(1))])).unwrap();
        assert_eq!(p["type"], 2);
        assert_eq!(p["application_id"], "app");
        assert_eq!(p["session_id"], "sess");
        assert_eq!(p["data"]["type"], 1);
        assert_eq!(p["data"]["version"], "20");
        assert_eq!(p["data"]["options"], json!([{ "type": 3, "name": "item", "value": "fish5m" }, { "type": 4, "name": "amount", "value": 1 }]));
    }

    #[test]
    fn nonce_is_a_snowflake() {
        let n: u64 = nonce(1_700_000_000_000).parse().unwrap();
        assert_eq!((n >> 22) as i64 + DISCORD_EPOCH_MS, 1_700_000_000_000);
    }
}
