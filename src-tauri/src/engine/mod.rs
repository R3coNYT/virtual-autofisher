//! Automation engine: queue, scheduler, game state, captcha flow, engine core and actor.

pub mod humanize;
pub mod queue;
pub mod game_state;
pub mod scheduler;
pub mod edit_deduper;
pub mod captcha;
pub mod core;
pub mod actor;
#[cfg(test)]
pub mod sim;
#[cfg(test)]
mod core_tests;
