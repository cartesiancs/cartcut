//! Turning a request into a response.
//!
//! Three read-only routes and a CORS preflight. Nothing here touches the disk
//! except to open a file the catalog already indexed.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

use hyper::body::{Bytes, Incoming};
use hyper::header;
use hyper::http::response::Builder;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Map, Value};

use crate::body::Body;
use crate::catalog::{Catalog, Kind};
use crate::State;

const CATALOG_CACHE: &str = "public, max-age=60";
/// Safe only because the app asks for every file with `?v=<sha256>`: new
/// bytes are a new URL, so no cache can hand back the old ones.
const FILE_CACHE: &str = "public, max-age=31536000, immutable";
const NO_STORE: &str = "no-store";

pub async fn handle(
    state: Arc<State>,
    request: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let started = Instant::now();
    let response = route(&state.catalog, request.method(), request.uri().path()).await;
    if state.log_requests {
        println!(
            "{} {} {} {:.1}ms",
            request.method(),
            request.uri().path(),
            response.status().as_u16(),
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(response)
}

async fn route(catalog: &Catalog, method: &Method, path: &str) -> Response<Body> {
    let head = match *method {
        Method::GET => false,
        Method::HEAD => true,
        Method::OPTIONS => return preflight(),
        _ => return method_not_allowed(),
    };

    let Some(rest) = path.strip_prefix("/v1/") else {
        return not_found();
    };
    if rest == "health" {
        return health(catalog, head);
    }
    if let Some(slug) = rest.strip_prefix("catalog/") {
        return match Kind::from_slug(slug) {
            Some(kind) => bytes(
                StatusCode::OK,
                "application/json",
                CATALOG_CACHE,
                catalog.listing(kind),
                head,
            ),
            None => error(StatusCode::NOT_FOUND, "unknown kind"),
        };
    }
    if let Some(tail) = rest.strip_prefix("files/") {
        return file(catalog, tail, head).await;
    }
    not_found()
}

fn health(catalog: &Catalog, head: bool) -> Response<Body> {
    let mut counts = Map::new();
    for kind in Kind::ALL {
        counts.insert(kind.slug().into(), Value::from(catalog.count(kind)));
    }
    let body = json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "counts": counts });
    bytes(
        StatusCode::OK,
        "application/json",
        NO_STORE,
        Bytes::from(body.to_string()),
        head,
    )
}

/// `files/{kind}/{id}/{path...}`, answered from the index and nothing else.
async fn file(catalog: &Catalog, tail: &str, head: bool) -> Response<Body> {
    let mut parts = tail.splitn(3, '/');
    let (Some(kind), Some(id), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
        return not_found();
    };
    let (Some(kind), Some(id), Some(path)) = (
        Kind::from_slug(kind),
        percent_decode(id),
        percent_decode(path),
    ) else {
        return not_found();
    };
    let Some(entry) = catalog.file(kind, &id, &path) else {
        return not_found();
    };

    let Ok(opened) = tokio::fs::File::open(&entry.path).await else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "file unavailable");
    };
    // The listing promised this length and this digest. A file edited since
    // the scan would break the promise halfway through the response.
    match opened.metadata().await {
        Ok(meta) if meta.len() == entry.bytes => {}
        _ => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "content changed since the server started",
            )
        }
    }

    let body = if head {
        Body::empty()
    } else {
        Body::file(opened, entry.bytes)
    };
    common(Response::builder().status(StatusCode::OK))
        .header(header::CONTENT_TYPE, entry.content_type)
        .header(header::CONTENT_LENGTH, entry.bytes)
        .header(header::CACHE_CONTROL, FILE_CACHE)
        .body(body)
        .expect("static headers are valid")
}

fn preflight() -> Response<Body> {
    common(Response::builder().status(StatusCode::NO_CONTENT))
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_MAX_AGE, "86400")
        .body(Body::empty())
        .expect("static headers are valid")
}

fn method_not_allowed() -> Response<Body> {
    let mut response = error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    response.headers_mut().insert(
        header::ALLOW,
        header::HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    response
}

fn not_found() -> Response<Body> {
    error(StatusCode::NOT_FOUND, "not found")
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    let body = json!({ "error": message });
    bytes(
        status,
        "application/json",
        NO_STORE,
        Bytes::from(body.to_string()),
        false,
    )
}

fn bytes(
    status: StatusCode,
    content_type: &str,
    cache: &str,
    payload: Bytes,
    head: bool,
) -> Response<Body> {
    let length = payload.len();
    common(Response::builder().status(status))
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, cache)
        .body(if head {
            Body::empty()
        } else {
            Body::bytes(payload)
        })
        .expect("static headers are valid")
}

/// On every response, so a browser build can read any of them.
fn common(builder: Builder) -> Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
}

/// `%XX` to bytes, then UTF-8. `None` for anything malformed, which names no file.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = raw.get(index + 1..index + 3)?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}
