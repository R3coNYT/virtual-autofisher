//! Discord user-account client: identity, message conversion, slash commands, Gateway + REST.

pub mod components;
pub mod identity;
pub mod model_conv;
pub mod slash;
pub mod client;
pub mod gateway;
pub mod permissions;
pub mod rest;

/// Virtual Fisher's bot/application id.
pub const VIRTUAL_FISHER_ID: &str = "574652751745777665";

pub use components::components_to_embeds;
pub use model_conv::to_bot_message;
pub use client::{DiscordClient, DiscordEvent, GatewayConfig, LiveClient, LoginError};
pub use slash::{interaction_payload, order_slash_args};
