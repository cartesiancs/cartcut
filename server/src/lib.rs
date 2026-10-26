//! Cartcut's cloud content server.
//!
//! Serves a folder of effects, transitions, graphics, LUTs, templates and
//! media to the app, read-only. `catalog` decides what exists, `routes`
//! answers requests from that decision, and `serve` is the accept loop. TLS
//! belongs to the reverse proxy in front of it.

pub mod body;
pub mod catalog;
pub mod gifs;
pub mod log;
mod routes;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;

pub use catalog::{load_catalog, Catalog, Kind};
pub use log::RequestLog;

/// A client that opens a connection and sends nothing holds a task until this.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct State {
    /// Swapped whole by `replace`. A request takes the `Arc` once and answers
    /// from it to the end, so a reload never shows it half of each catalog.
    catalog: RwLock<Arc<Catalog>>,
    /// One line per request, to a file per day. `None` in the test suite.
    pub requests: Option<RequestLog>,
}

impl State {
    pub fn new(catalog: Catalog, requests: Option<RequestLog>) -> State {
        State {
            catalog: RwLock::new(Arc::new(catalog)),
            requests,
        }
    }

    pub fn catalog(&self) -> Arc<Catalog> {
        // A poisoned lock still holds a whole catalog: the writer only ever
        // assigns one.
        let guard = self
            .catalog
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        Arc::clone(&guard)
    }

    /// Serve `catalog` from the next request on. What SIGHUP calls.
    pub fn replace(&self, catalog: Catalog) {
        let mut guard = self
            .catalog
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Arc::new(catalog);
    }
}

/// Accept connections on `listener` until the task is dropped.
///
/// An accept error (out of file descriptors, most often) pauses and carries
/// on rather than returning: one bad moment must not take the server down.
pub async fn serve(listener: TcpListener, state: Arc<State>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                eprintln!("accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };

        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let service = service_fn(move |request| routes::handle(Arc::clone(&state), request));
            // An error here is a client that hung up or timed out. There is
            // nobody to tell.
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}
