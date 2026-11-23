//! Discord Gateway v9 session for a user account: Hello → Identify/Resume → dispatches, heartbeats,
//! reconnect with Resume (session_id + seq), Invalid Session handling. Runs until `stop` is set.

use super::identity::identify_payload;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fatal {
    /// Close 4004 (authentication failed) or 4010–4014.
    InvalidToken,
    /// Could not reach the Gateway before the first READY.
    Network,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GatewayEvent {
    Ready(Value),
    Dispatch { t: String, d: Value },
    Disconnected,
    Reconnected,
    Fatal(Fatal),
}

enum Exit {
    Reconnect { resume: bool },
    Fatal(Fatal),
    Stopped,
}

#[derive(Default)]
struct SessionState {
    session_id: Option<String>,
    resume_url: Option<String>,
    seq: Option<u64>,
    ready_once: bool,
    disconnected: bool,
}

/// Runs the Gateway session. Events go to `tx`; payloads received on `outbound` are sent as is
/// (e.g. op 37 guild subscriptions); set `stop` to true to close it.
pub async fn run(
    url: String,
    token: String,
    tx: mpsc::UnboundedSender<GatewayEvent>,
    mut outbound: mpsc::UnboundedReceiver<Value>,
    mut stop: watch::Receiver<bool>,
) {
    let mut st = SessionState::default();
    let mut failures: u32 = 0;
    loop {
        if *stop.borrow() {
            return;
        }
        let target = match (&st.session_id, &st.resume_url) {
            (Some(_), Some(r)) => format!("{}/?v=9&encoding=json", r.trim_end_matches('/')),
            _ => url.clone(),
        };
        let exit = session_once(&target, &token, &mut st, &tx, &mut outbound, &mut stop).await;
        match exit {
            Exit::Stopped => return,
            Exit::Fatal(f) => {
                let _ = tx.send(GatewayEvent::Fatal(f));
                return;
            }
            Exit::Reconnect { resume } => {
                if !st.ready_once {
                    let _ = tx.send(GatewayEvent::Fatal(Fatal::Network));
                    return;
                }
                if !resume {
                    st.session_id = None;
                    st.seq = None;
                }
                if !st.disconnected {
                    st.disconnected = true;
                    let _ = tx.send(GatewayEvent::Disconnected);
                }
                failures += 1;
                let backoff = [1u64, 2, 5, 10, 30][(failures as usize - 1).min(4)];
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                    _ = stop.changed() => return,
                }
            }
        }
        if st.ready_once && !st.disconnected {
            failures = 0;
        }
    }
}

async fn session_once(
    url: &str,
    token: &str,
    st: &mut SessionState,
    tx: &mpsc::UnboundedSender<GatewayEvent>,
    outbound: &mut mpsc::UnboundedReceiver<Value>,
    stop: &mut watch::Receiver<bool>,
) -> Exit {
    let Ok((ws, _)) = tokio_tungstenite::connect_async(url).await else {
        return Exit::Reconnect { resume: true };
    };
    let (mut sink, mut stream) = ws.split();
    let mut heartbeat: Option<tokio::time::Interval> = None;
    let mut acked = true;

    loop {
        let tick = async {
            match heartbeat.as_mut() {
                Some(h) => {
                    h.tick().await;
                }
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = stop.changed() => {
                let _ = sink.close().await;
                return Exit::Stopped;
            }
            Some(payload) = outbound.recv() => {
                if sink.send(Message::text(payload.to_string())).await.is_err() {
                    return Exit::Reconnect { resume: true };
                }
            }
            _ = tick => {
                if !acked {
                    return Exit::Reconnect { resume: true }; // zombie connection
                }
                acked = false;
                if sink.send(Message::text(json!({ "op": 1, "d": st.seq }).to_string())).await.is_err() {
                    return Exit::Reconnect { resume: true };
                }
            }
            msg = stream.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    _ => return Exit::Reconnect { resume: true },
                };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Close(frame) => {
                        let code = frame.map(|f| u16::from(f.code)).unwrap_or(1000);
                        return match code {
                            4004 | 4010..=4014 => Exit::Fatal(Fatal::InvalidToken),
                            4007 | 4009 => Exit::Reconnect { resume: false },
                            _ => Exit::Reconnect { resume: true },
                        };
                    }
                    Message::Binary(b) => {
                        // not expected (compress is off): surfaced for diagnostics only
                        let _ = tx.send(GatewayEvent::Dispatch { t: "<binary frame>".into(), d: json!(b.len()) });
                        continue;
                    }
                    _ => continue,
                };
                let Ok(p) = serde_json::from_str::<Value>(&text) else { continue };
                match p["op"].as_u64() {
                    Some(10) => {
                        let interval = p["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250);
                        let first = (interval as f64 * rand::rng().random_range(0.0..1.0)) as u64;
                        let mut h = tokio::time::interval_at(
                            tokio::time::Instant::now() + Duration::from_millis(first),
                            Duration::from_millis(interval),
                        );
                        h.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                        heartbeat = Some(h);
                        let hello_reply = match &st.session_id {
                            Some(sid) => json!({ "op": 6, "d": { "token": token, "session_id": sid, "seq": st.seq } }),
                            None => json!({ "op": 2, "d": identify_payload(token) }),
                        };
                        if sink.send(Message::text(hello_reply.to_string())).await.is_err() {
                            return Exit::Reconnect { resume: true };
                        }
                    }
                    Some(11) => acked = true,
                    Some(1) => {
                        let _ = sink.send(Message::text(json!({ "op": 1, "d": st.seq }).to_string())).await;
                    }
                    Some(7) => return Exit::Reconnect { resume: true },
                    Some(9) => {
                        let resumable = p["d"].as_bool().unwrap_or(false);
                        let wait = rand::rng().random_range(1000..5000);
                        tokio::time::sleep(Duration::from_millis(wait)).await;
                        return Exit::Reconnect { resume: resumable };
                    }
                    Some(0) => {
                        if let Some(s) = p["s"].as_u64() {
                            st.seq = Some(s);
                        }
                        let t = p["t"].as_str().unwrap_or("").to_string();
                        let d = p["d"].clone();
                        match t.as_str() {
                            "READY" => {
                                st.session_id = d["session_id"].as_str().map(str::to_string);
                                st.resume_url = d["resume_gateway_url"].as_str().map(str::to_string);
                                let was_down = st.disconnected;
                                st.disconnected = false;
                                st.ready_once = true;
                                let _ = tx.send(GatewayEvent::Ready(d));
                                if was_down {
                                    let _ = tx.send(GatewayEvent::Reconnected);
                                }
                            }
                            "RESUMED" => {
                                if st.disconnected {
                                    st.disconnected = false;
                                    let _ = tx.send(GatewayEvent::Reconnected);
                                }
                            }
                            _ => {
                                let _ = tx.send(GatewayEvent::Dispatch { t, d });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
pub mod mock {
    //! A scriptable mock Gateway for tests.
    use futures_util::{SinkExt, StreamExt};
    use serde_json::Value;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    pub enum Out {
        Json(Value),
        Close(u16),
    }

    /// Spawns a server; each accepted connection gets its own (inbound, outbound) channel pair.
    pub async fn serve() -> (String, mpsc::UnboundedReceiver<(mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Out>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (conn_tx, conn_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let (mut sink, mut stream) = ws.split();
                let (in_tx, in_rx) = mpsc::unbounded_channel::<Value>();
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
                conn_tx.send((in_rx, out_tx)).unwrap();
                tokio::spawn(async move {
                    while let Some(Ok(Message::Text(t))) = stream.next().await {
                        if let Ok(v) = serde_json::from_str(&t) {
                            let _ = in_tx.send(v);
                        }
                    }
                });
                tokio::spawn(async move {
                    while let Some(o) = out_rx.recv().await {
                        let msg = match o {
                            Out::Json(v) => Message::text(v.to_string()),
                            Out::Close(code) => Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: code.into(),
                                reason: "".into(),
                            })),
                        };
                        if sink.send(msg).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (url, conn_rx)
    }
}

#[cfg(test)]
mod tests {
    use super::mock::*;
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    async fn next<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
        timeout(Duration::from_secs(10), rx.recv()).await.expect("timed out").expect("closed")
    }

    fn hello() -> Out {
        Out::Json(json!({ "op": 10, "d": { "heartbeat_interval": 45000 } }))
    }
    fn ready(url: &str) -> Out {
        Out::Json(json!({ "op": 0, "s": 1, "t": "READY", "d": {
            "session_id": "sess1", "resume_gateway_url": url, "user": { "id": "111", "username": "me" }, "guilds": []
        }}))
    }

    #[tokio::test]
    async fn identifies_like_the_library_and_reports_ready() {
        let (url, mut conns) = serve().await;
        let (tx, mut events) = mpsc::unbounded_channel();
        let (_stop_tx, stop) = watch::channel(false);
        let (_out_tx, out_rx) = mpsc::unbounded_channel();
        tokio::spawn(run(url.clone(), "tok".into(), tx, out_rx, stop));
        let (mut inbound, out) = next(&mut conns).await;
        out.send(hello()).ok();
        let identify = next(&mut inbound).await;
        assert_eq!(identify["op"], 2);
        assert_eq!(identify["d"]["token"], "tok");
        assert_eq!(identify["d"]["properties"]["browser"], "Discord Client");
        out.send(ready(&url)).ok();
        assert!(matches!(next(&mut events).await, GatewayEvent::Ready(d) if d["session_id"] == "sess1"));
        out.send(Out::Json(json!({ "op": 0, "s": 2, "t": "MESSAGE_CREATE", "d": { "id": "m" } }))).ok();
        assert!(matches!(next(&mut events).await, GatewayEvent::Dispatch { t, .. } if t == "MESSAGE_CREATE"));
    }

    #[tokio::test]
    async fn resume_after_close() {
        let (url, mut conns) = serve().await;
        let (tx, mut events) = mpsc::unbounded_channel();
        let (_stop_tx, stop) = watch::channel(false);
        let (_out_tx, out_rx) = mpsc::unbounded_channel();
        tokio::spawn(run(url.clone(), "tok".into(), tx, out_rx, stop));
        let (mut inbound, out) = next(&mut conns).await;
        out.send(hello()).ok();
        next(&mut inbound).await; // identify
        out.send(ready(&url)).ok();
        next(&mut events).await; // ready
        out.send(Out::Json(json!({ "op": 0, "s": 7, "t": "MESSAGE_CREATE", "d": {} }))).ok();
        next(&mut events).await;
        out.send(Out::Close(4000)).ok();
        assert_eq!(next(&mut events).await, GatewayEvent::Disconnected);
        let (mut inbound2, out2) = next(&mut conns).await;
        out2.send(hello()).ok();
        let resume = next(&mut inbound2).await;
        assert_eq!(resume["op"], 6);
        assert_eq!(resume["d"]["session_id"], "sess1");
        assert_eq!(resume["d"]["seq"], 7);
        out2.send(Out::Json(json!({ "op": 0, "s": 8, "t": "RESUMED", "d": {} }))).ok();
        assert_eq!(next(&mut events).await, GatewayEvent::Reconnected);
    }

    #[tokio::test]
    async fn invalid_session_reidentifies() {
        let (url, mut conns) = serve().await;
        let (tx, mut events) = mpsc::unbounded_channel();
        let (_stop_tx, stop) = watch::channel(false);
        let (_out_tx, out_rx) = mpsc::unbounded_channel();
        tokio::spawn(run(url.clone(), "tok".into(), tx, out_rx, stop));
        let (mut inbound, out) = next(&mut conns).await;
        out.send(hello()).ok();
        next(&mut inbound).await;
        out.send(ready(&url)).ok();
        next(&mut events).await;
        out.send(Out::Json(json!({ "op": 9, "d": false }))).ok();
        assert_eq!(next(&mut events).await, GatewayEvent::Disconnected);
        let (mut inbound2, out2) = next(&mut conns).await;
        out2.send(hello()).ok();
        assert_eq!(next(&mut inbound2).await["op"], 2); // fresh Identify, not Resume
        out2.send(ready(&url)).ok();
        assert!(matches!(next(&mut events).await, GatewayEvent::Ready(_)));
        assert_eq!(next(&mut events).await, GatewayEvent::Reconnected);
    }

    #[tokio::test]
    async fn auth_failure_is_invalid_token_and_unreachable_is_network() {
        let (url, mut conns) = serve().await;
        let (tx, mut events) = mpsc::unbounded_channel();
        let (_s, stop) = watch::channel(false);
        let (_o1, out_rx) = mpsc::unbounded_channel();
        tokio::spawn(run(url, "bad".into(), tx, out_rx, stop));
        let (mut inbound, out) = next(&mut conns).await;
        out.send(hello()).ok();
        next(&mut inbound).await;
        out.send(Out::Close(4004)).ok();
        assert_eq!(next(&mut events).await, GatewayEvent::Fatal(Fatal::InvalidToken));

        let (tx2, mut events2) = mpsc::unbounded_channel();
        let (_s2, stop2) = watch::channel(false);
        let (_o2, out_rx2) = mpsc::unbounded_channel();
        tokio::spawn(run("ws://127.0.0.1:1".into(), "t".into(), tx2, out_rx2, stop2));
        assert_eq!(next(&mut events2).await, GatewayEvent::Fatal(Fatal::Network));
    }
}
