//! Owner live checkpoint 1: checks the Rust Discord client on a real account.
//!
//! Token from the VAF_TOKEN environment variable (never printed). Usage:
//!   cargo run --example discord_probe                          → user + servers (Virtual Fisher first)
//!   cargo run --example discord_probe -- <guildId>             → + that server's usable channels
//!   cargo run --example discord_probe -- --send <channelId> profile   → sends /profile, prints the reply

use std::sync::Arc;
use std::time::Duration;
use virtual_autofisher_lib::discord::{DiscordClient, DiscordEvent, GatewayConfig, LiveClient};
use virtual_autofisher_lib::logger::Logger;
use virtual_autofisher_lib::model::SlashOptions;

#[tokio::main]
async fn main() {
    let token = std::env::var("VAF_TOKEN").expect("set VAF_TOKEN to your Discord token");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let logs = std::env::temp_dir().join("vaf-probe-logs");
    let client = LiveClient::new(GatewayConfig::default(), Arc::new(Logger::new(logs)));

    let user = match client.login(&token).await {
        Ok(u) => u,
        Err(e) => return eprintln!("login failed: {e}"),
    };
    println!("Logged in as {} ({})", user.username, user.id);

    match client.list_guilds(false).await {
        Ok(guilds) => {
            println!("\nServers ({}):", guilds.len());
            for g in &guilds {
                println!("  {} {:<40} {}", if g.has_virtual_fisher { "[VF]" } else { "    " }, g.name, g.id);
            }
        }
        Err(e) => eprintln!("guild list failed: {e}"),
    }

    if let Some(i) = args.iter().position(|a| a == "--send") {
        let channel = args.get(i + 1).expect("--send <channelId> <command>").clone();
        let command = args.get(i + 2).cloned().unwrap_or_else(|| "profile".into());
        let mut events = client.subscribe();
        client.set_active_channel(Some(channel.clone()));
        if let Err(e) = client.send_slash(&channel, &command, SlashOptions::new()).await {
            return eprintln!("/{command} failed: {e}");
        }
        println!("\n/{command} sent, waiting for the reply (30 s)...");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while let Ok(Ok(ev)) = tokio::time::timeout_at(deadline, events.recv()).await {
            if let DiscordEvent::BotMessage(m) = ev {
                println!("\n--- reply (edit: {}, thinking: {}) ---", m.is_edit, m.loading);
                for e in &m.embeds {
                    if let Some(t) = &e.title { println!("# {t}"); }
                    if let Some(d) = &e.description { println!("{d}"); }
                    if let Some(img) = &e.image_url { println!("[image] {img}"); }
                }
                if !m.loading { break; }
            }
        }
    } else if let Some(guild) = args.first() {
        match client.list_channels(guild).await {
            Ok(chs) => {
                println!("\nChannels where you can use slash commands in {guild}:");
                for c in chs {
                    println!("  #{:<30} {:<24} {}", c.name, c.parent_name.unwrap_or_default(), c.id);
                }
            }
            Err(e) => eprintln!("channel list failed: {e}"),
        }
    }
    client.logout().await;
}
