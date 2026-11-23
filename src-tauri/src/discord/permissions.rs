//! Channel permissions for the logged-in user (Discord's documented algorithm), to list only the
//! channels where slash commands can be used.

use serde_json::Value;

pub const ADMINISTRATOR: u64 = 1 << 3;
pub const VIEW_CHANNEL: u64 = 1 << 10;
pub const SEND_MESSAGES: u64 = 1 << 11;
pub const USE_APPLICATION_COMMANDS: u64 = 1 << 31;
const NEEDED: u64 = VIEW_CHANNEL | SEND_MESSAGES | USE_APPLICATION_COMMANDS;

fn bits(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0),
        Value::Number(n) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// Permissions of `user_id` (with `member_roles`) in `channel` of `guild` (raw Gateway JSON).
pub fn channel_permissions(guild: &Value, channel: &Value, user_id: &str, member_roles: &[String]) -> u64 {
    let guild_id = guild["id"].as_str().unwrap_or("");
    if guild["owner_id"].as_str() == Some(user_id) {
        return u64::MAX;
    }
    let roles = guild["roles"].as_array().cloned().unwrap_or_default();
    let role_perms = |id: &str| roles.iter().find(|r| r["id"].as_str() == Some(id)).map(|r| bits(&r["permissions"]));
    let mut base = role_perms(guild_id).unwrap_or(0); // @everyone role id == guild id
    for r in member_roles {
        base |= role_perms(r).unwrap_or(0);
    }
    if base & ADMINISTRATOR != 0 {
        return u64::MAX;
    }
    let overwrites = channel["permission_overwrites"].as_array().cloned().unwrap_or_default();
    let ow = |id: &str| overwrites.iter().find(|o| o["id"].as_str() == Some(id));
    let mut perms = base;
    if let Some(o) = ow(guild_id) {
        perms = (perms & !bits(&o["deny"])) | bits(&o["allow"]);
    }
    let (mut allow, mut deny) = (0u64, 0u64);
    for r in member_roles {
        if let Some(o) = ow(r) {
            allow |= bits(&o["allow"]);
            deny |= bits(&o["deny"]);
        }
    }
    perms = (perms & !deny) | allow;
    if let Some(o) = ow(user_id) {
        perms = (perms & !bits(&o["deny"])) | bits(&o["allow"]);
    }
    perms
}

pub fn can_use_commands(guild: &Value, channel: &Value, user_id: &str, member_roles: &[String]) -> bool {
    channel_permissions(guild, channel, user_id, member_roles) & NEEDED == NEEDED
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EVERYONE_OK: u64 = VIEW_CHANNEL | SEND_MESSAGES | USE_APPLICATION_COMMANDS;

    fn guild(everyone: u64) -> Value {
        json!({ "id": "g", "owner_id": "owner", "roles": [
            { "id": "g", "permissions": everyone.to_string() },
            { "id": "mod", "permissions": EVERYONE_OK.to_string() },
            { "id": "admin", "permissions": ADMINISTRATOR.to_string() }
        ]})
    }

    #[test]
    fn everyone_role_allows() {
        assert!(can_use_commands(&guild(EVERYONE_OK), &json!({}), "u", &[]));
        assert!(!can_use_commands(&guild(VIEW_CHANNEL | SEND_MESSAGES), &json!({}), "u", &[]));
    }

    #[test]
    fn owner_and_admin_always_allowed() {
        assert!(can_use_commands(&guild(0), &json!({}), "owner", &[]));
        assert!(can_use_commands(&guild(0), &json!({}), "u", &["admin".to_string()]));
    }

    #[test]
    fn overwrites_deny_then_role_and_member_allow() {
        let ch = json!({ "permission_overwrites": [
            { "id": "g", "type": 0, "allow": "0", "deny": SEND_MESSAGES.to_string() },
            { "id": "mod", "type": 0, "allow": SEND_MESSAGES.to_string(), "deny": "0" }
        ]});
        assert!(!can_use_commands(&guild(EVERYONE_OK), &ch, "u", &[]));
        assert!(can_use_commands(&guild(EVERYONE_OK), &ch, "u", &["mod".to_string()]));
        let member_deny = json!({ "permission_overwrites": [
            { "id": "u", "type": 1, "allow": "0", "deny": VIEW_CHANNEL.to_string() }
        ]});
        assert!(!can_use_commands(&guild(EVERYONE_OK), &member_deny, "u", &[]));
    }

    #[test]
    fn role_grants_missing_permission() {
        assert!(can_use_commands(&guild(0), &json!({}), "u", &["mod".to_string()]));
    }
}
