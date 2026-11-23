//! Gateway message JSON → `BotMessage`.
//!
//! SAFETY-CRITICAL: `to_bot_message` is the only filter keeping other players' Virtual Fisher
//! replies away from the engine. Accept only messages from the bot that belong to us.

use super::components::components_to_embeds;
use super::VIRTUAL_FISHER_ID;
use crate::model::{BotMessage, Embed, EmbedField};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

const EPHEMERAL: u64 = 64;
const LOADING: u64 = 128; // deferred interaction reply, edited later into the real one

fn image_ext() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(png|jpe?g|webp|gif)(?:$|\?)").expect("valid regex"))
}

fn first_image_attachment(msg: &Value) -> Option<String> {
    msg["attachments"].as_array()?.iter().find_map(|a| {
        let url = a["url"].as_str()?;
        let ct = a["content_type"].as_str().unwrap_or("");
        let name = a["filename"].as_str().unwrap_or("");
        (ct.to_ascii_lowercase().starts_with("image/") || image_ext().is_match(name) || image_ext().is_match(url))
            .then(|| url.to_string())
    })
}

fn mentions_user(msg: &Value, self_id: &str) -> bool {
    let listed = msg["mentions"]
        .as_array()
        .is_some_and(|m| m.iter().any(|u| u["id"].as_str() == Some(self_id)));
    let content = msg["content"].as_str().unwrap_or("");
    listed || content.contains(&format!("<@{self_id}>")) || content.contains(&format!("<@!{self_id}>"))
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// Converts a Gateway MESSAGE_CREATE/UPDATE payload. None when it is not ours (see module doc).
pub fn to_bot_message(msg: &Value, self_id: &str, is_edit: bool) -> Option<BotMessage> {
    if msg["author"]["id"].as_str() != Some(VIRTUAL_FISHER_ID) {
        return None;
    }
    let interaction_user_id = msg["interaction_metadata"]["user"]["id"]
        .as_str()
        .or_else(|| msg["interaction"]["user"]["id"].as_str())
        .map(str::to_string);
    let flags = msg["flags"].as_u64().unwrap_or(0);
    let ephemeral = flags & EPHEMERAL != 0;
    let ours = interaction_user_id.as_deref() == Some(self_id) || mentions_user(msg, self_id) || ephemeral;
    if !ours {
        return None;
    }

    let mut embeds: Vec<Embed> = msg["embeds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| Embed {
            title: opt_str(&e["title"]),
            description: opt_str(&e["description"]),
            fields: e["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| EmbedField {
                    name: f["name"].as_str().unwrap_or("").to_string(),
                    value: f["value"].as_str().unwrap_or("").to_string(),
                })
                .collect(),
            image_url: opt_str(&e["image"]["url"]),
            footer: opt_str(&e["footer"]["text"]),
        })
        .collect();
    if let Some(components) = msg["components"].as_array().filter(|c| !c.is_empty()) {
        embeds.extend(components_to_embeds(components));
    }
    if !embeds.iter().any(|e| e.image_url.is_some()) {
        if let Some(url) = first_image_attachment(msg) {
            match embeds.first_mut() {
                Some(e) => e.image_url = Some(url),
                None => embeds.push(Embed { image_url: Some(url), ..Embed::default() }),
            }
        }
    }

    Some(BotMessage {
        id: msg["id"].as_str().unwrap_or("").to_string(),
        channel_id: msg["channel_id"].as_str().unwrap_or("").to_string(),
        content: msg["content"].as_str().unwrap_or("").to_string(),
        embeds,
        ephemeral,
        loading: flags & LOADING != 0,
        is_edit,
        interaction_user_id,
    })
}

/// Test helpers: anonymized captures (`tests/fixtures/messages/{real,v2}`) converted like live messages.
#[cfg(test)]
pub mod testkit {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// Anonymized user id used in the real fixtures.
    pub const REAL_SELF_ID: &str = "111";

    pub fn fixture_path(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(rel)
    }

    pub fn read_json(rel: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(fixture_path(rel)).unwrap()).unwrap()
    }

    /// Loads a capture of `dir` ("real" or "v2") as the Gateway would deliver it, through `to_bot_message`.
    pub fn load_capture(dir: &str, name: &str) -> BotMessage {
        let raw = read_json(&format!("messages/{dir}/{name}.json"));
        let gw = json!({
            "id": raw["id"],
            "channel_id": raw["channelId"],
            "content": raw["content"].as_str().unwrap_or(""),
            "author": { "id": VIRTUAL_FISHER_ID },
            "flags": 0,
            "interaction": raw["interactionUserId"].as_str().map(|u| json!({ "user": { "id": u } })),
            "components": raw["rawComponents"],
        });
        let is_edit = raw["isEdit"].as_bool().unwrap_or(false);
        to_bot_message(&gw, REAL_SELF_ID, is_edit).unwrap_or_else(|| panic!("fixture {name} rejected"))
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use serde_json::json;

    const SELF: &str = "111";
    const OTHER: &str = "222";

    fn make(over: Value) -> Value {
        let mut m = json!({
            "id": "m1", "channel_id": "c1", "content": "hello",
            "author": { "id": VIRTUAL_FISHER_ID }, "embeds": [], "flags": 0, "mentions": []
        });
        for (k, v) in over.as_object().unwrap() {
            m[k] = v.clone();
        }
        m
    }

    #[test]
    fn rejects_messages_not_authored_by_virtual_fisher() {
        let m = make(json!({ "author": { "id": OTHER }, "interaction": { "user": { "id": SELF } } }));
        assert!(to_bot_message(&m, SELF, false).is_none());
    }

    #[test]
    fn rejects_another_players_interaction_without_mention() {
        let a = make(json!({ "interaction": { "user": { "id": OTHER } }, "content": "You may now continue." }));
        assert!(to_bot_message(&a, SELF, false).is_none());
        let b = make(json!({ "interaction_metadata": { "user": { "id": OTHER } } }));
        assert!(to_bot_message(&b, SELF, false).is_none());
    }

    #[test]
    fn rejects_no_interaction_no_mention_not_ephemeral() {
        assert!(to_bot_message(&make(json!({})), SELF, false).is_none());
    }

    #[test]
    fn accepts_a_reply_to_our_interaction() {
        let r = to_bot_message(&make(json!({ "interaction": { "user": { "id": SELF } } })), SELF, false).unwrap();
        assert_eq!(r.id, "m1");
        assert_eq!(r.channel_id, "c1");
        assert_eq!(r.interaction_user_id.as_deref(), Some(SELF));
        assert!(!r.ephemeral && !r.is_edit);
    }

    #[test]
    fn interaction_metadata_wins_over_interaction() {
        let m = make(json!({ "interaction_metadata": { "user": { "id": OTHER } }, "interaction": { "user": { "id": SELF } } }));
        assert!(to_bot_message(&m, SELF, false).is_none());
        let ok = make(json!({ "interaction_metadata": { "user": { "id": SELF } } }));
        assert!(to_bot_message(&ok, SELF, false).is_some());
    }

    #[test]
    fn accepts_mentions_list_and_content_mentions() {
        assert!(to_bot_message(&make(json!({ "mentions": [{ "id": SELF }] })), SELF, false).is_some());
        assert!(to_bot_message(&make(json!({ "content": "hey <@111>" })), SELF, false).is_some());
        assert!(to_bot_message(&make(json!({ "content": "hey <@!111>" })), SELF, false).is_some());
        assert!(to_bot_message(&make(json!({ "content": "id 111 in text" })), SELF, false).is_none());
    }

    #[test]
    fn mentioned_in_another_users_reply_keeps_their_id() {
        let m = make(json!({ "interaction": { "user": { "id": OTHER } }, "mentions": [{ "id": SELF }] }));
        assert_eq!(to_bot_message(&m, SELF, false).unwrap().interaction_user_id.as_deref(), Some(OTHER));
    }

    #[test]
    fn ephemeral_and_loading_flags() {
        let e = to_bot_message(&make(json!({ "flags": 64 })), SELF, false).unwrap();
        assert!(e.ephemeral && !e.loading);
        let l = to_bot_message(&make(json!({ "flags": 128, "interaction": { "user": { "id": SELF } } })), SELF, false).unwrap();
        assert!(l.loading);
    }

    #[test]
    fn maps_embeds_including_image_and_footer() {
        let m = make(json!({
            "interaction": { "user": { "id": SELF } },
            "embeds": [{ "title": "T", "description": "D", "fields": [{ "name": "n", "value": "v" }],
                         "image": { "url": "https://x/i.png" }, "footer": { "text": "F" } }]
        }));
        let e = &to_bot_message(&m, SELF, false).unwrap().embeds[0];
        assert_eq!((e.title.as_deref(), e.description.as_deref(), e.footer.as_deref()), (Some("T"), Some("D"), Some("F")));
        assert_eq!(e.image_url.as_deref(), Some("https://x/i.png"));
        assert_eq!(e.fields, vec![EmbedField { name: "n".into(), value: "v".into() }]);
    }

    #[test]
    fn edits_use_the_same_rule() {
        let m = make(json!({ "interaction": { "user": { "id": SELF } } }));
        assert!(to_bot_message(&m, SELF, true).unwrap().is_edit);
        let foreign = make(json!({ "interaction": { "user": { "id": OTHER } } }));
        assert!(to_bot_message(&foreign, SELF, true).is_none());
    }

    #[test]
    fn first_image_attachment_becomes_the_image() {
        let m = make(json!({
            "interaction": { "user": { "id": SELF } },
            "attachments": [{ "url": "https://cdn/x.txt", "filename": "x.txt" }, { "url": "https://cdn/c.png", "filename": "c.png" }]
        }));
        assert_eq!(to_bot_message(&m, SELF, false).unwrap().embeds[0].image_url.as_deref(), Some("https://cdn/c.png"));
    }

    #[test]
    fn real_captures_convert_like_v1() {
        for name in [
            "catch-before-edit", "catch-chest-lava", "catch-chest-xp", "catch-crate-gold-quest", "catch-levelup-quest",
            "catch-plain", "daily-cooldown", "edit-other-player", "inventory", "quests",
        ] {
            let expected: Vec<Embed> =
                serde_json::from_value(read_json(&format!("messages/real/{name}.json"))["embeds"].clone()).unwrap();
            assert_eq!(load_capture("real", name).embeds, expected, "fixture {name}");
        }
    }
}
