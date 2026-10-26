//! Turning a request into a response.
//!
//! The root, the read-only routes under `/v1/` and a CORS preflight. Nothing
//! here touches the disk except to open a file the catalog already indexed.

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
use crate::gifs::{tokens_of, GifQuery, MAX_LIMIT};
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
    let catalog = state.catalog();
    let response = route(
        &catalog,
        request.method(),
        request.uri().path(),
        request.uri().query(),
    )
    .await;
    if let Some(log) = &state.requests {
        log.record(format!(
            "{} {} {} {:.1}ms",
            request.method(),
            request.uri().path(),
            response.status().as_u16(),
            started.elapsed().as_secs_f64() * 1000.0
        ));
    }
    Ok(response)
}

async fn route(
    catalog: &Catalog,
    method: &Method,
    path: &str,
    query: Option<&str>,
) -> Response<Body> {
    let head = match *method {
        Method::GET => false,
        Method::HEAD => true,
        Method::OPTIONS => return preflight(),
        _ => return method_not_allowed(),
    };

    if path == "/" {
        return root(head);
    }
    let Some(rest) = path.strip_prefix("/v1/") else {
        return not_found();
    };
    if rest == "health" {
        return health(catalog, head);
    }
    if let Some(slug) = rest.strip_prefix("catalog/") {
        return match Kind::from_slug(slug).map(|kind| catalog.listing(kind)) {
            Some(Some(listing)) => bytes(
                StatusCode::OK,
                "application/json",
                CATALOG_CACHE,
                listing,
                head,
            ),
            // GIFs are a page at a time, never the whole list.
            Some(None) => error(StatusCode::NOT_FOUND, "listed by /v1/gifs"),
            None => error(StatusCode::NOT_FOUND, "unknown kind"),
        };
    }
    if rest == "gifs" {
        return match parse_gif_query(query) {
            Ok(query) => bytes(
                StatusCode::OK,
                "application/json",
                CATALOG_CACHE,
                catalog.gifs().page(&query),
                head,
            ),
            Err(message) => error(StatusCode::BAD_REQUEST, message),
        };
    }
    if let Some(id) = rest.strip_prefix("gifs/item/") {
        return match percent_decode(id).and_then(|id| catalog.gifs().item(&id)) {
            Some(item) => bytes(
                StatusCode::OK,
                "application/json",
                CATALOG_CACHE,
                item,
                head,
            ),
            None => not_found(),
        };
    }
    if let Some(tail) = rest.strip_prefix("files/") {
        return file(catalog, tail, head).await;
    }
    not_found()
}

/// `/`, for whatever probes a host's root before routing traffic to it. Its
/// own body rather than `health`'s: it says the server is up and which build it
/// is, and leaves what is being served to `/v1/health`.
fn root(head: bool) -> Response<Body> {
    let body = json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": env!("CARGO_PKG_VERSION"),
        "ok": true,
    });
    bytes(
        StatusCode::OK,
        "application/json",
        NO_STORE,
        Bytes::from(body.to_string()),
        head,
    )
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

/// `/v1/gifs`'s query string: `q`, `cursor`, `limit`.
///
/// A key it does not know is ignored and a repeated one is the last. A
/// search that is too long is cut (`gifs.rs#tokens_of`) and a limit out of
/// range is clamped, since both have an obvious meaning; a cursor it cannot
/// read is refused, since guessing one hands back the wrong page.
fn parse_gif_query(raw: Option<&str>) -> Result<GifQuery, &'static str> {
    let mut query = GifQuery::default();
    for pair in raw.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value =
            percent_decode(&value.replace('+', " ")).ok_or("the query is not valid UTF-8")?;
        match key {
            "q" => query.tokens = tokens_of(&value),
            "cursor" => {
                query.cursor = if value.is_empty() {
                    0
                } else if value.bytes().all(|b| b.is_ascii_digit()) && value.len() <= 9 {
                    value.parse().map_err(|_| "cursor is not a page position")?
                } else {
                    return Err("cursor is not a page position");
                };
            }
            "limit" => {
                let limit: usize = if value.bytes().all(|b| b.is_ascii_digit())
                    && !value.is_empty()
                    && value.len() <= 9
                {
                    value.parse().map_err(|_| "limit is not a number")?
                } else {
                    return Err("limit is not a number");
                };
                query.limit = limit.clamp(1, MAX_LIMIT);
            }
            _ => {}
        }
    }
    Ok(query)
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
