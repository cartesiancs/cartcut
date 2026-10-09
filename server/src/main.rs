use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use cartcut_cloud::{load_catalog, serve, Kind, State};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let bind = env::var("CARTCUT_CLOUD_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let content =
        PathBuf::from(env::var("CARTCUT_CLOUD_CONTENT").unwrap_or_else(|_| "content".into()));

    let (catalog, warnings) = load_catalog(&content);
    for warning in &warnings {
        eprintln!("warning: {warning}");
    }
    for kind in Kind::ALL {
        println!("{:>10}: {}", kind.slug(), catalog.count(kind));
    }

    let listener = match TcpListener::bind(&bind).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("cannot listen on {bind}: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "serving {} on http://{}",
        content.display(),
        listener.local_addr().map(|a| a.to_string()).unwrap_or(bind)
    );

    let state = Arc::new(State {
        catalog,
        log_requests: true,
    });
    tokio::select! {
        _ = serve(listener, state) => {}
        _ = tokio::signal::ctrl_c() => println!("shutting down"),
    }
}
