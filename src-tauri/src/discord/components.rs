//! Discord "Components V2" (CONTAINER / TEXT_DISPLAY / SECTION / MEDIA_GALLERY / THUMBNAIL)
//! turned into embed-like text, so the parser works on one shape.

use crate::model::Embed;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn kind(c: &Value) -> Option<&'static str> {
    match &c["type"] {
        Value::Number(n) => match n.as_u64()? {
            17 => Some("CONTAINER"),
            10 => Some("TEXT_DISPLAY"),
            9 => Some("SECTION"),
            12 => Some("MEDIA_GALLERY"),
            11 => Some("THUMBNAIL"),
            _ => None,
        },
        Value::String(s) => ["CONTAINER", "TEXT_DISPLAY", "SECTION", "MEDIA_GALLERY", "THUMBNAIL"]
            .into_iter()
            .find(|k| k == s),
        _ => None,
    }
}

#[derive(Default)]
struct Acc {
    texts: Vec<String>,
    image: Option<String>,
}

/// Collects the text and the first image of a component tree (buttons are ignored).
fn walk(c: &Value, acc: &mut Acc) {
    let k = kind(c);
    match k {
        Some("TEXT_DISPLAY") => {
            if let Some(t) = c["content"].as_str().filter(|t| !t.is_empty()) {
                acc.texts.push(t.to_string());
            }
        }
        Some("MEDIA_GALLERY") if acc.image.is_none() => {
            acc.image = c["items"]
                .as_array()
                .and_then(|items| items.iter().find_map(|i| i["media"]["url"].as_str()))
                .map(str::to_string);
        }
        Some("THUMBNAIL") if acc.image.is_none() => {
            acc.image = c["media"]["url"].as_str().map(str::to_string);
        }
        _ => {}
    }
    if matches!(k, Some("CONTAINER") | Some("SECTION")) {
        for child in c["components"].as_array().into_iter().flatten() {
            walk(child, acc);
        }
    }
    if c["accessory"].is_object() {
        walk(&c["accessory"], acc);
    }
}

fn heading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // A heading (`### Title`) or a line that is entirely bold (`**Title**`).
    RE.get_or_init(|| Regex::new(r"^(?:#{1,3}\s+(.+?)|\*\*([^*]+)\*\*)\s*$").expect("valid regex"))
}

/// One embed per top-level container (loose text displays/sections form one more).
/// The first line becomes the title when it is a heading or a bold-only line.
pub fn components_to_embeds(components: &[Value]) -> Vec<Embed> {
    let mut groups: Vec<Vec<&Value>> = Vec::new();
    let mut loose: Vec<&Value> = Vec::new();
    for c in components {
        if kind(c) == Some("CONTAINER") {
            groups.push(vec![c]);
        } else {
            loose.push(c);
        }
    }
    if !loose.is_empty() {
        groups.push(loose);
    }
    let mut embeds = Vec::new();
    for group in groups {
        let mut acc = Acc::default();
        for c in group {
            walk(c, &mut acc);
        }
        let joined = acc.texts.join("\n");
        let lines: Vec<&str> = joined.split('\n').collect();
        let first = lines.first().map(|l| l.trim()).unwrap_or("");
        let title = heading()
            .captures(first)
            .and_then(|m| m.get(1).or_else(|| m.get(2)))
            .map(|m| m.as_str().trim().to_string());
        let body = if title.is_some() { &lines[1..] } else { &lines[..] };
        let description = body.join("\n").trim().to_string();
        if title.is_none() && description.is_empty() && acc.image.is_none() {
            continue;
        }
        embeds.push(Embed {
            title,
            description: (!description.is_empty()).then_some(description),
            fields: vec![],
            image_url: acc.image,
            footer: None,
        });
    }
    embeds
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(s: &str) -> Value {
        json!({ "type": 10, "content": s })
    }
    fn container(children: Vec<Value>) -> Value {
        json!({ "type": 17, "components": children })
    }

    #[test]
    fn container_becomes_embed_with_heading_title() {
        let e = components_to_embeds(&[container(vec![
            text("### Inventory of Player_One"),
            text("Balance: **$1**."),
            json!({ "type": 14 }),
            json!({ "type": 1, "components": [{ "type": 2, "label": "Return" }] }),
        ])]);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].title.as_deref(), Some("Inventory of Player_One"));
        assert_eq!(e[0].description.as_deref(), Some("Balance: **$1**."));
    }

    #[test]
    fn bold_only_first_line_is_a_title() {
        let e = components_to_embeds(&[container(vec![text("**Player One**\n### You caught:\n2 <:s:1> Squid")])]);
        assert_eq!(e[0].title.as_deref(), Some("Player One"));
        assert!(e[0].description.as_deref().unwrap().starts_with("### You caught:"));
    }

    #[test]
    fn media_gallery_and_thumbnail_give_the_image() {
        let e = components_to_embeds(&[container(vec![
            text("Please solve the captcha with /verify"),
            json!({ "type": 12, "items": [{ "media": { "url": "https://media.discordapp.net/c.png" } }] }),
        ])]);
        assert_eq!(e[0].image_url.as_deref(), Some("https://media.discordapp.net/c.png"));
        let t = components_to_embeds(&[json!({ "type": 9, "components": [text("x")], "accessory": { "type": 11, "media": { "url": "u" } } })]);
        assert_eq!(t[0].image_url.as_deref(), Some("u"));
    }

    #[test]
    fn library_string_types_are_accepted() {
        let e = components_to_embeds(&[json!({ "type": "CONTAINER", "components": [{ "type": "TEXT_DISPLAY", "content": "hello" }] })]);
        assert_eq!(e[0].description.as_deref(), Some("hello"));
    }

    #[test]
    fn empty_tree_gives_no_embed() {
        assert!(components_to_embeds(&[container(vec![json!({ "type": 14 })])]).is_empty());
    }
}
