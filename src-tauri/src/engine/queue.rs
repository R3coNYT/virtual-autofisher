//! Single serialized channel for slash commands (port of `CommandQueue.ts`), as a pure state machine:
//! one command in flight, released by a response or the timeout, never closer than the min gap to the
//! previous send. Time is passed in; the owner polls at `next_wakeup()`.

use crate::model::SlashOptions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Manual,
    Verify,
    Maintenance,
    Fish,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedCommand {
    pub name: String,
    pub options: SlashOptions,
    pub priority: Priority,
    pub key: Option<String>,
    /// Identifies this command (and tells a retry copy apart from its original).
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum QueueAction {
    Send(QueuedCommand),
    TimedOut(QueuedCommand),
}

pub struct CommandQueue {
    items: Vec<(QueuedCommand, u64)>,
    seq: u64,
    in_flight: Option<(QueuedCommand, i64)>,
    last_send_at: Option<i64>,
    hold_until: i64,
    paused: bool,
    response_timeout_ms: i64,
}

impl CommandQueue {
    pub fn new(response_timeout_ms: i64) -> Self {
        Self { items: vec![], seq: 0, in_flight: None, last_send_at: None, hold_until: i64::MIN, paused: false, response_timeout_ms }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// False when a command with the same key is already queued.
    pub fn push(&mut self, c: QueuedCommand) -> bool {
        if c.key.is_some() && self.items.iter().any(|(e, _)| e.key == c.key) {
            return false;
        }
        self.items.push((c, self.seq));
        self.seq += 1;
        true
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }
    pub fn pause(&mut self) {
        self.paused = true;
    }
    pub fn resume(&mut self) {
        self.paused = false;
    }
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Nothing is sent until `ms` have elapsed (e.g. Discord 429 retry_after).
    pub fn hold_for(&mut self, now: i64, ms: i64) {
        self.hold_until = self.hold_until.max(now + ms);
    }

    /// The bot answered the in-flight command. No-op if nothing is in flight.
    pub fn notify_response(&mut self) {
        self.in_flight = None;
    }

    /// Deferred reply: wait up to `ms` from now instead of the normal timeout.
    pub fn extend_timeout(&mut self, now: i64, ms: i64) {
        if let Some((_, deadline)) = self.in_flight.as_mut() {
            *deadline = now + ms;
        }
    }

    /// Sending failed: releases the in-flight command (the caller reports it).
    pub fn send_failed(&mut self) -> Option<QueuedCommand> {
        self.in_flight.take().map(|(c, _)| c)
    }

    pub fn in_flight(&self) -> Option<&QueuedCommand> {
        self.in_flight.as_ref().map(|(c, _)| c)
    }

    /// Best eligible entry: priority then arrival; only `Verify` while paused.
    fn next_index(&self) -> Option<usize> {
        self.items
            .iter()
            .enumerate()
            .filter(|(_, (c, _))| !self.paused || c.priority == Priority::Verify)
            .min_by_key(|(_, (c, seq))| (c.priority, *seq))
            .map(|(i, _)| i)
    }

    fn ready_at(&self, min_gap_ms: i64) -> i64 {
        let gap = self.last_send_at.map_or(i64::MIN, |t| t + min_gap_ms);
        gap.max(self.hold_until)
    }

    /// What happens at `now`: a timeout of the in-flight command, or the next send.
    pub fn poll(&mut self, now: i64, min_gap_ms: i64) -> Option<QueueAction> {
        if let Some((_, deadline)) = &self.in_flight {
            if now >= *deadline {
                return self.in_flight.take().map(|(c, _)| QueueAction::TimedOut(c));
            }
            return None;
        }
        let i = self.next_index()?;
        if now < self.ready_at(min_gap_ms) {
            return None;
        }
        let (c, _) = self.items.remove(i);
        self.in_flight = Some((c.clone(), now + self.response_timeout_ms));
        self.last_send_at = Some(now);
        Some(QueueAction::Send(c))
    }

    /// When `poll` should be called next (None: nothing to do until something changes).
    pub fn next_wakeup(&self, min_gap_ms: i64) -> Option<i64> {
        if let Some((_, deadline)) = &self.in_flight {
            return Some(*deadline);
        }
        self.next_index().map(|_| self.ready_at(min_gap_ms).max(i64::MIN + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAP: i64 = 2500;

    fn cmd(name: &str, priority: Priority, key: Option<&str>) -> QueuedCommand {
        QueuedCommand { name: name.into(), options: SlashOptions::new(), priority, key: key.map(str::to_string), id: 0 }
    }
    fn sent(a: Option<QueueAction>) -> String {
        match a {
            Some(QueueAction::Send(c)) => c.name,
            other => panic!("expected a send, got {other:?}"),
        }
    }

    #[test]
    fn manual_before_an_earlier_fish_and_priority_then_arrival() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("fish", Priority::Fish, None));
        q.push(cmd("sell", Priority::Maintenance, None));
        q.push(cmd("top", Priority::Manual, None));
        q.push(cmd("daily", Priority::Maintenance, None));
        let mut order = vec![];
        let mut t = 0;
        while order.len() < 4 {
            if let Some(QueueAction::Send(c)) = q.poll(t, GAP) {
                order.push(c.name);
                q.notify_response();
            }
            t += 500;
        }
        assert_eq!(order, ["top", "sell", "daily", "fish"]);
    }

    #[test]
    fn waits_for_the_response_and_for_the_min_gap() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("a", Priority::Fish, None));
        q.push(cmd("b", Priority::Fish, None));
        assert_eq!(sent(q.poll(0, GAP)), "a");
        assert_eq!(q.poll(5000, GAP), None); // no response yet
        q.notify_response();
        assert_eq!(sent(q.poll(5000, GAP)), "b");
        // a fast response still respects the gap
        q.push(cmd("c", Priority::Fish, None));
        q.notify_response();
        assert_eq!(q.poll(6000, GAP), None);
        assert_eq!(q.next_wakeup(GAP), Some(7500));
        assert_eq!(sent(q.poll(7500, GAP)), "c");
    }

    #[test]
    fn reads_min_gap_at_each_decision() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("a", Priority::Fish, None));
        q.poll(0, GAP);
        q.notify_response();
        q.push(cmd("b", Priority::Fish, None));
        assert_eq!(q.poll(2600, 3000), None);
        assert_eq!(sent(q.poll(3000, 3000)), "b");
    }

    #[test]
    fn times_out_after_8000_ms_and_continues() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("a", Priority::Fish, None));
        q.push(cmd("b", Priority::Fish, None));
        q.poll(0, GAP);
        assert_eq!(q.poll(7999, GAP), None);
        assert!(matches!(q.poll(8000, GAP), Some(QueueAction::TimedOut(c)) if c.name == "a"));
        assert_eq!(sent(q.poll(8000, GAP)), "b");
    }

    #[test]
    fn no_timeout_after_a_response_and_notify_without_flight_is_noop() {
        let mut q = CommandQueue::new(8000);
        q.notify_response();
        q.push(cmd("a", Priority::Fish, None));
        q.poll(0, GAP);
        q.notify_response();
        assert_eq!(q.poll(9000, GAP), None);
    }

    #[test]
    fn rejects_a_duplicate_key() {
        let mut q = CommandQueue::new(8000);
        assert!(q.push(cmd("sell", Priority::Maintenance, Some("sell"))));
        assert!(!q.push(cmd("sell", Priority::Maintenance, Some("sell"))));
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn pause_resume_and_verify_while_paused() {
        let mut q = CommandQueue::new(8000);
        q.pause();
        q.push(cmd("fish", Priority::Fish, None));
        assert_eq!(q.poll(0, GAP), None);
        q.push(cmd("verify", Priority::Verify, None));
        assert_eq!(sent(q.poll(0, GAP)), "verify");
        q.notify_response();
        assert_eq!(q.poll(10_000, GAP), None);
        q.resume();
        assert_eq!(sent(q.poll(10_000, GAP)), "fish");
    }

    #[test]
    fn hold_for_blocks_until_elapsed() {
        let mut q = CommandQueue::new(8000);
        q.hold_for(0, 5000);
        q.push(cmd("a", Priority::Manual, None));
        assert_eq!(q.poll(4999, GAP), None);
        assert_eq!(sent(q.poll(5000, GAP)), "a");
    }

    #[test]
    fn send_failure_releases_and_continues() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("a", Priority::Fish, None));
        q.push(cmd("b", Priority::Fish, None));
        q.poll(0, GAP);
        assert_eq!(q.send_failed().map(|c| c.name), Some("a".into()));
        assert_eq!(sent(q.poll(2500, GAP)), "b");
    }

    #[test]
    fn extend_timeout_and_clear() {
        let mut q = CommandQueue::new(8000);
        q.push(cmd("a", Priority::Fish, None));
        q.poll(0, GAP);
        q.extend_timeout(1000, 30_000);
        assert_eq!(q.poll(20_000, GAP), None);
        assert!(matches!(q.poll(31_000, GAP), Some(QueueAction::TimedOut(_))));
        q.push(cmd("b", Priority::Fish, None));
        q.clear();
        assert!(q.is_empty() && q.next_wakeup(GAP).is_none());
    }
}
