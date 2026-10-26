use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use cartcut_cloud::{load_catalog, serve, Kind, RequestLog, State};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let bind = env::var("CARTCUT_CLOUD_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let content =
        PathBuf::from(env::var("CARTCUT_CLOUD_CONTENT").unwrap_or_else(|_| "content".into()));
    let logs = PathBuf::from(env::var("CARTCUT_CLOUD_LOGS").unwrap_or_else(|_| "logs".into()));

    // Every file is read and hashed before the first request is answered,
    // which takes seconds for a large folder: say so, or it looks hung.
    println!("scanning {} ...", content.display());
    let (catalog, warnings) = load_catalog(&content);
    report(&catalog, &warnings);

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

    // Serving matters more than the log: one that cannot be written is
    // reported and the server answers anyway.
    let requests = match RequestLog::open(&logs) {
        Ok(log) => {
            println!("logging requests to {}", logs.display());
            Some(log)
        }
        Err(error) => {
            eprintln!("cannot log requests to {}: {error}", logs.display());
            None
        }
    };

    let state = Arc::new(State::new(catalog, requests));
    tokio::select! {
        _ = serve(listener, Arc::clone(&state)) => {}
        _ = reload_on_hangup(Arc::clone(&state), content) => {}
        _ = tokio::signal::ctrl_c() => println!("shutting down"),
    }
}

fn report(catalog: &cartcut_cloud::Catalog, warnings: &[String]) {
    for warning in warnings {
        eprintln!("warning: {warning}");
    }
    for kind in Kind::ALL {
        println!("{:>10}: {}", kind.slug(), catalog.count(kind));
    }
}

/// `kill -HUP <pid>` scans the content folder again and serves the result,
/// so a GIF copied into `content/gifs/` needs no restart.
/// The scan reads and hashes every file, so it runs off the request threads.
#[cfg(unix)]
async fn reload_on_hangup(state: Arc<State>, content: PathBuf) {
    use tokio::signal::unix::{signal, SignalKind};
    let Ok(mut hangups) = signal(SignalKind::hangup()) else {
        eprintln!("cannot listen for SIGHUP; restart to publish a change");
        return std::future::pending().await;
    };
    while hangups.recv().await.is_some() {
        let root = content.clone();
        match tokio::task::spawn_blocking(move || load_catalog(&root)).await {
            Ok((catalog, warnings)) => {
                println!("reloaded {}", content.display());
                report(&catalog, &warnings);
                state.replace(catalog);
            }
            Err(error) => eprintln!("reload failed, still serving the old catalog: {error}"),
        }
    }
}

/// Windows has no SIGHUP. Restart to publish a change there.
#[cfg(not(unix))]
async fn reload_on_hangup(_state: Arc<State>, _content: PathBuf) {
    std::future::pending().await
}
