//! The HTTP API, exercised over real sockets.
//!
//! Every test starts its own server on an ephemeral port against
//! `tests/fixtures/content`. That folder holds one working item of each kind
//! (they load in the app too, which is why the same folder doubles as the
//! development server's content), five GIFs named by their tags for the paged
//! search, and things that must never be served: a manifest that is not JSON,
//! an id that repeats another in different case, a `.js` file beside a shader,
//! and a `.gif` that is not a GIF.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cartcut_cloud::{load_catalog, serve, Kind, State};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::client::conn::http1::SendRequest;
use hyper::header::HeaderMap;
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const EFFECT: &str = "com.cartcut.cloud.duotone-sunset";
/// The kinds listed whole under `/v1/catalog`. GIFs are paged instead.
const KINDS: [&str; 6] = [
    "effect",
    "transition",
    "graphic",
    "lut",
    "template",
    "asset",
];

fn content() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/content")
}

async fn start() -> SocketAddr {
    start_on(&content()).await.0
}

/// A server on `root`, and its state, so a test can reload it.
async fn start_on(root: &std::path::Path) -> (SocketAddr, Arc<State>) {
    let (catalog, _) = load_catalog(root);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(State::new(catalog, None));
    tokio::spawn(serve(listener, Arc::clone(&state)));
    (addr, state)
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("a JSON body")
    }

    fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }
}

async fn connect(addr: SocketAddr) -> SendRequest<Empty<Bytes>> {
    let stream = TcpStream::connect(addr).await.unwrap();
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    sender
}

async fn send_on(sender: &mut SendRequest<Empty<Bytes>>, method: Method, path: &str) -> Reply {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "localhost")
        .body(Empty::new())
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    Reply {
        status: parts.status,
        headers: parts.headers,
        body,
    }
}

async fn send(addr: SocketAddr, method: Method, path: &str) -> Reply {
    let mut sender = connect(addr).await;
    send_on(&mut sender, method, path).await
}

async fn get(addr: SocketAddr, path: &str) -> Reply {
    send(addr, Method::GET, path).await
}

/// Bytes written straight onto the socket, for requests no client library
/// would agree to build.
async fn raw(addr: SocketAddr, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out))
        .await
        .expect("the server closes the connection")
        .unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

fn status_of(response: &str) -> u16 {
    response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

async fn catalog(addr: SocketAddr, kind: &str) -> Vec<Value> {
    let reply = get(addr, &format!("/v1/catalog/{kind}")).await;
    assert_eq!(reply.status, 200, "catalog/{kind}");
    let body = reply.json();
    assert_eq!(body["kind"], kind);
    body["items"].as_array().expect("an items array").clone()
}

fn item<'a>(items: &'a [Value], id: &str) -> &'a Value {
    items
        .iter()
        .find(|entry| entry["id"] == id)
        .unwrap_or_else(|| panic!("{id} is listed"))
}

fn paths_of(entry: &Value) -> Vec<String> {
    entry["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap().to_owned())
        .collect()
}

fn file_url(kind: &str, id: &str, path: &str) -> String {
    format!("/v1/files/{kind}/{id}/{path}")
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
async fn the_root_answers_200_with_its_own_json() {
    let addr = start().await;
    let reply = get(addr, "/").await;

    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), "application/json");
    assert_eq!(reply.header("cache-control"), "no-store");
    assert_eq!(
        reply.json(),
        json!({ "name": "cartcut-cloud", "version": env!("CARGO_PKG_VERSION"), "ok": true })
    );

    let head = send(addr, Method::HEAD, "/").await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(head.header("content-length"), reply.body.len().to_string());
}

#[tokio::test]
async fn health_reports_what_is_being_served() {
    let addr = start().await;
    let reply = get(addr, "/v1/health").await;

    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("cache-control"), "no-store");
    let body = reply.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        body["counts"],
        json!({
            "effect": 1, "transition": 1, "graphic": 1, "lut": 1, "template": 1, "asset": 3, "gif": 5
        })
    );
}

#[tokio::test]
async fn every_kind_lists_its_items() {
    let addr = start().await;

    let presets = [
        ("effect", EFFECT, "Sunset Duotone", "color"),
        (
            "transition",
            "com.cartcut.cloud.ember-burn",
            "Ember Burn",
            "light",
        ),
        (
            "graphic",
            "com.cartcut.cloud.graphic.tally",
            "Tally Counter",
            "layout",
        ),
        (
            "lut",
            "com.cartcut.cloud.lut.honey-glow",
            "Honey Glow",
            "warm",
        ),
    ];
    for (kind, id, name, category) in presets {
        let items = catalog(addr, kind).await;
        assert_eq!(items.len(), 1, "{kind}");
        let found = item(&items, id);
        assert_eq!(found["kind"], kind);
        assert_eq!(found["name"], name);
        assert_eq!(found["category"], category);
        assert_eq!(found["author"], "Cartcut");
        assert_eq!(found["schema"], 1);
        assert_eq!(found["thumbnail"], "thumbnail.png");
        assert!(paths_of(found).contains(&"manifest.json".to_owned()));
    }

    let templates = catalog(addr, "template").await;
    let template = item(&templates, "cloud-rising-title");
    assert_eq!(template["name"], "Rising Title");
    assert_eq!(template["schema"], 3);
    assert_eq!(template["thumbnail"], "thumbnail.png");
    assert_eq!(
        paths_of(template),
        ["template.json", "template.ngt", "thumbnail.png"]
    );

    let assets = catalog(addr, "asset").await;
    let names: Vec<&str> = assets.iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["A440 Tone", "Colour Bars", "Dusk Gradient"],
        "by name"
    );

    let video = item(&assets, "cloud-color-bars");
    assert_eq!(video["file"], "bars.mp4");
    assert_eq!(video["category"], "Test patterns");
    assert_eq!(
        video["media"],
        json!({ "type": "video", "durationMs": 2000, "width": 320, "height": 180 })
    );
    assert_eq!(paths_of(video), ["asset.json", "bars.mp4", "thumbnail.png"]);

    // An image with no thumbnail of its own is its own; a sound has none.
    assert_eq!(
        item(&assets, "cloud-dusk-gradient")["thumbnail"],
        "gradient.png"
    );
    let audio = item(&assets, "cloud-a440");
    assert_eq!(audio["thumbnail"], Value::Null);
    assert_eq!(audio["media"]["type"], "audio");
    assert_eq!(audio["media"]["width"], Value::Null);
}

#[tokio::test]
async fn listed_sizes_and_digests_match_the_served_bytes() {
    let addr = start().await;
    let mut checked = 0;

    for kind in KINDS {
        for entry in catalog(addr, kind).await {
            let id = entry["id"].as_str().unwrap();
            let mut total = 0u64;
            for file in entry["files"].as_array().unwrap() {
                let path = file["path"].as_str().unwrap();
                let reply = get(addr, &file_url(kind, id, path)).await;
                assert_eq!(reply.status, 200, "{kind}/{id}/{path}");
                assert_eq!(
                    reply.body.len() as u64,
                    file["bytes"].as_u64().unwrap(),
                    "{path}"
                );
                assert_eq!(
                    sha256(&reply.body),
                    file["sha256"].as_str().unwrap(),
                    "{path}"
                );
                total += reply.body.len() as u64;
                checked += 1;
            }
            assert_eq!(entry["bytes"].as_u64().unwrap(), total, "{kind}/{id}");
        }
    }
    assert!(checked >= 20, "only {checked} files were compared");

    // And against the disk, read by code that shares nothing with the server.
    let on_disk =
        std::fs::read(content().join("effects/cloud-duotone-sunset/shader.frag")).unwrap();
    let effects = catalog(addr, "effect").await;
    let listed = item(&effects, EFFECT)["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "shader.frag")
        .unwrap()
        .clone();
    assert_eq!(listed["sha256"], sha256(&on_disk));
    assert_eq!(listed["bytes"], on_disk.len());
    assert_ne!(listed["sha256"], sha256(b"something else"));
}

#[tokio::test]
async fn a_file_arrives_with_its_length_type_and_cache_policy() {
    let addr = start().await;
    let cases = [
        ("effect", EFFECT, "manifest.json", "application/json"),
        ("effect", EFFECT, "shader.frag", "text/plain; charset=utf-8"),
        (
            "graphic",
            "com.cartcut.cloud.graphic.tally",
            "index.html",
            "text/html; charset=utf-8",
        ),
        (
            "graphic",
            "com.cartcut.cloud.graphic.tally",
            "style.css",
            "text/css; charset=utf-8",
        ),
        (
            "lut",
            "com.cartcut.cloud.lut.honey-glow",
            "lut.cube",
            "text/plain; charset=utf-8",
        ),
        ("asset", "cloud-color-bars", "bars.mp4", "video/mp4"),
        ("asset", "cloud-a440", "a440.wav", "audio/wav"),
        ("asset", "cloud-dusk-gradient", "gradient.png", "image/png"),
        (
            "template",
            "cloud-rising-title",
            "template.ngt",
            "application/octet-stream",
        ),
    ];

    for (kind, id, path, content_type) in cases {
        let reply = get(addr, &file_url(kind, id, path)).await;
        assert_eq!(reply.status, 200, "{path}");
        assert!(!reply.body.is_empty(), "{path}");
        assert_eq!(reply.header("content-type"), content_type, "{path}");
        assert_eq!(
            reply.header("content-length"),
            reply.body.len().to_string(),
            "{path}"
        );
        assert_eq!(
            reply.header("cache-control"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(reply.header("access-control-allow-origin"), "*");
        assert_eq!(reply.header("x-content-type-options"), "nosniff");
    }

    // The app's cache-busting query plays no part in the lookup.
    let busted = get(
        addr,
        &format!("{}?v=0123abcd", file_url("effect", EFFECT, "shader.frag")),
    )
    .await;
    assert_eq!(busted.status, 200);

    let listing = get(addr, "/v1/catalog/effect").await;
    assert_eq!(listing.header("content-type"), "application/json");
    assert_eq!(listing.header("cache-control"), "public, max-age=60");
}

#[tokio::test]
async fn head_sends_the_headers_and_no_body() {
    let addr = start().await;

    for url in [
        file_url("asset", "cloud-color-bars", "bars.mp4"),
        "/v1/catalog/effect".to_owned(),
    ] {
        let full = get(addr, &url).await;
        let head = send(addr, Method::HEAD, &url).await;
        assert!(!full.body.is_empty(), "{url}");
        assert_eq!(head.status, 200, "{url}");
        assert!(head.body.is_empty(), "{url}");
        assert_eq!(
            head.header("content-length"),
            full.body.len().to_string(),
            "{url}"
        );
        assert_eq!(
            head.header("content-type"),
            full.header("content-type"),
            "{url}"
        );
    }
}

#[tokio::test]
async fn no_path_outside_the_index_is_served() {
    let addr = start().await;
    let attempts = [
        format!("/v1/files/effect/{EFFECT}/../../../Cargo.toml"),
        format!("/v1/files/effect/{EFFECT}/%2e%2e/%2e%2e/%2e%2e/Cargo.toml"),
        format!("/v1/files/effect/{EFFECT}/%2E%2E%2F%2E%2E%2F%2E%2E%2FCargo.toml"),
        format!("/v1/files/effect/{EFFECT}//etc/passwd"),
        format!("/v1/files/effect/{EFFECT}/%2Fetc%2Fpasswd"),
        format!("/v1/files/effect/{EFFECT}/./shader.frag"),
        format!("/v1/files/effect/{EFFECT}/shader.frag%00"),
        format!("/v1/files/effect/{EFFECT}/"),
        format!("/v1/files/effect/{EFFECT}"),
        "/v1/files/../effect/x/manifest.json".to_owned(),
        // The folder name is where it sits on the server, not its id.
        "/v1/files/effect/cloud-duotone-sunset/manifest.json".to_owned(),
        // The right id under the wrong kind.
        format!("/v1/files/transition/{EFFECT}/shader.frag"),
    ];
    for path in &attempts {
        let reply = get(addr, path).await;
        assert_eq!(reply.status, 404, "{path}");
        assert!(reply.json()["error"].is_string(), "{path}");
    }

    // A backslash and a broken escape are not URI characters, so no client
    // library will send them. The bytes go straight onto the socket.
    for target in [
        format!("/v1/files/effect/{EFFECT}/..\\..\\..\\Cargo.toml"),
        format!("/v1/files/effect/{EFFECT}/%zz"),
        format!("/v1/files/effect/{EFFECT}/%2"),
    ] {
        let response = raw(
            addr,
            format!("GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await;
        let status = status_of(&response);
        assert!(status == 400 || status == 404, "{target} answered {status}");
    }
}

#[tokio::test]
async fn a_file_the_app_would_not_read_is_neither_listed_nor_served() {
    let addr = start().await;
    assert!(
        content()
            .join("effects/cloud-duotone-sunset/evil.js")
            .is_file(),
        "the fixture is still there to be refused"
    );

    let effects = catalog(addr, "effect").await;
    assert_eq!(
        paths_of(item(&effects, EFFECT)),
        ["manifest.json", "shader.frag", "thumbnail.png"]
    );
    let reply = get(addr, &file_url("effect", EFFECT, "evil.js")).await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn a_broken_or_duplicate_folder_costs_only_itself() {
    let addr = start().await;
    assert!(content()
        .join("effects/broken-manifest/manifest.json")
        .is_file());
    assert!(content()
        .join("effects/duplicate-id/manifest.json")
        .is_file());

    let effects = catalog(addr, "effect").await;
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0]["id"], EFFECT);
    // Not the `Duplicate Duotone` that claims the same id in capitals.
    assert_eq!(effects[0]["name"], "Sunset Duotone");

    // And every other kind is unaffected.
    for kind in ["transition", "graphic", "lut", "template"] {
        assert_eq!(catalog(addr, kind).await.len(), 1, "{kind}");
    }
}

#[tokio::test]
async fn unknown_routes_and_methods_are_refused_with_json() {
    let addr = start().await;

    for path in [
        "/v1/catalog/plugin",
        "/v1/catalog/",
        "/v1/nothing",
        "//",
        "/index.html",
        "/v2/health",
        "/v1/health/",
    ] {
        let reply = get(addr, path).await;
        assert_eq!(reply.status, 404, "{path}");
        assert_eq!(reply.header("content-type"), "application/json", "{path}");
        assert!(reply.json()["error"].is_string(), "{path}");
    }

    for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
        let reply = send(addr, method.clone(), "/v1/catalog/effect").await;
        assert_eq!(reply.status, 405, "{method}");
        assert_eq!(reply.header("allow"), "GET, HEAD, OPTIONS", "{method}");
    }
}

#[tokio::test]
async fn a_preflight_allows_any_origin() {
    let addr = start().await;

    let reply = send(addr, Method::OPTIONS, "/v1/catalog/effect").await;
    assert_eq!(reply.status, 204);
    assert!(reply.body.is_empty());
    assert_eq!(reply.header("access-control-allow-origin"), "*");
    assert_eq!(
        reply.header("access-control-allow-methods"),
        "GET, HEAD, OPTIONS"
    );

    let listing = get(addr, "/v1/catalog/effect").await;
    assert_eq!(listing.header("access-control-allow-origin"), "*");
}

#[tokio::test]
async fn one_connection_carries_several_requests() {
    let addr = start().await;
    let mut sender = connect(addr).await;

    let first = send_on(&mut sender, Method::GET, "/v1/health").await;
    let second = send_on(
        &mut sender,
        Method::GET,
        &file_url("effect", EFFECT, "shader.frag"),
    )
    .await;
    let third = send_on(&mut sender, Method::GET, "/v1/nothing").await;
    let fourth = send_on(&mut sender, Method::GET, "/v1/catalog/lut").await;

    assert_eq!(
        [first.status, second.status, third.status, fourth.status].map(|s| s.as_u16()),
        [200, 200, 404, 200]
    );
}

#[tokio::test]
async fn every_listed_thumbnail_is_an_image_that_downloads() {
    let addr = start().await;
    let mut served = 0;

    for kind in KINDS {
        for entry in catalog(addr, kind).await {
            let Some(thumbnail) = entry["thumbnail"].as_str() else {
                continue;
            };
            let id = entry["id"].as_str().unwrap();
            assert!(
                paths_of(&entry).contains(&thumbnail.to_owned()),
                "{id} downloads its thumbnail too"
            );

            let reply = get(addr, &file_url(kind, id, thumbnail)).await;
            assert_eq!(reply.status, 200, "{kind}/{id}");
            assert!(
                reply.header("content-type").starts_with("image/"),
                "{kind}/{id}"
            );
            assert!(
                reply.body.starts_with(b"\x89PNG\r\n\x1a\n"),
                "{kind}/{id} is a PNG"
            );
            served += 1;
        }
    }
    // effect, transition, graphic, lut, template, the video and the image.
    assert_eq!(served, 7);
}

#[tokio::test]
async fn a_malformed_request_is_answered_400() {
    let addr = start().await;

    let response = raw(addr, b"\x01\x02 not http\r\n\r\n").await;
    assert_eq!(status_of(&response), 400, "{response}");

    let response = raw(addr, b"GET /v1/health HTTP/1.1\r\nHost localhost\r\n\r\n").await;
    assert_eq!(status_of(&response), 400, "{response}");
}

// ------------------------------------------------------------------ gifs

/// The five fixture GIFs that load, in name order.
const GIFS: [&str; 5] = [
    "fire hot handwarmer 불 불꽃",
    "grinning face smile 웃음 미소",
    "red heart love 하트 사랑",
    "thumbs up good 좋아요 따봉",
    "waving hand hello 안녕",
];

async fn gif_page(addr: SocketAddr, query: &str) -> Value {
    let reply = get(addr, &format!("/v1/gifs{query}")).await;
    assert_eq!(reply.status, 200, "/v1/gifs{query}: {:?}", reply.body);
    reply.json()
}

fn names(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("an items array")
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn gifs_come_a_page_at_a_time_in_name_order() {
    let addr = start().await;

    let reply = get(addr, "/v1/gifs?limit=2").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), "application/json");
    assert_eq!(reply.header("cache-control"), "public, max-age=60");
    let first = reply.json();
    assert_eq!(names(&first), GIFS[..2]);
    assert_eq!(first["next"], "2");
    assert_eq!(first["total"], 5);
    let rev = first["rev"].as_str().unwrap().to_owned();
    assert_eq!(rev.len(), 16);

    // Walking the cursor visits every GIF once and ends on `next: null`.
    let mut seen = names(&first);
    let mut next = first["next"].as_str().map(str::to_owned);
    while let Some(cursor) = next {
        let page = gif_page(addr, &format!("?limit=2&cursor={cursor}")).await;
        assert_eq!(page["rev"], rev.as_str());
        seen.extend(names(&page));
        next = page["next"].as_str().map(str::to_owned);
    }
    assert_eq!(seen, GIFS);
    assert_eq!(gif_page(addr, "").await["next"], Value::Null);
}

#[tokio::test]
async fn a_gif_is_one_file_and_its_name_is_its_tags() {
    let addr = start().await;
    let fire = &gif_page(addr, "?limit=1").await["items"][0];
    assert_eq!(fire["kind"], "gif");
    assert_eq!(fire["name"], "fire hot handwarmer 불 불꽃");
    assert_eq!(
        fire["tags"],
        json!(["fire", "hot", "handwarmer", "불", "불꽃"])
    );
    assert_eq!(fire["file"], "fire_hot_handwarmer_불_불꽃.gif");
    assert_eq!(paths_of(fire), ["fire_hot_handwarmer_불_불꽃.gif"]);
    // An ASCII id, since the name is not one.
    let id = fire["id"].as_str().unwrap();
    assert!(
        id.starts_with('g') && id.len() == 17 && id.is_ascii(),
        "{id}"
    );

    // A space inside a part is part of the tag.
    let thumbs = &gif_page(addr, "?q=thumbs").await["items"][0];
    assert_eq!(
        thumbs["tags"],
        json!(["thumbs up", "good", "좋아요", "따봉"])
    );
}

#[tokio::test]
async fn every_word_of_a_search_has_to_start_a_tag() {
    let addr = start().await;
    let search = |q: &'static str| async move { names(&gif_page(addr, &format!("?q={q}")).await) };

    assert_eq!(search("fi").await, [GIFS[0]]);
    assert_eq!(search("FIRE").await, [GIFS[0]]);
    // 웃 starts 웃음.
    assert_eq!(search("%EC%9B%83").await, [GIFS[1]]);
    // #불, as someone types a tag.
    assert_eq!(search("%23%EB%B6%88").await, [GIFS[0]]);
    // :heart:, as someone types an emoji code.
    assert_eq!(search("%3Aheart%3A").await, [GIFS[2]]);
    // Two words, each starting a different tag of one GIF.
    assert_eq!(search("good+%EB%94%B0").await, [GIFS[3]]);
    // A word inside a tag with a space in it.
    assert_eq!(search("up").await, [GIFS[3]]);
    // Every word has to match, not any.
    let none = gif_page(addr, "?q=heart+fire").await;
    assert_eq!(names(&none), Vec::<String>::new());
    assert_eq!(none["total"], 0);
    assert_eq!(none["next"], Value::Null);
}

#[tokio::test]
async fn a_whole_tag_outranks_one_a_word_only_starts() {
    let addr = start().await;
    // "hand" is a whole tag of the waving hand and only the start of the
    // fire's "handwarmer", which comes first by name. The whole tag wins.
    assert_eq!(names(&gif_page(addr, "?q=hand").await), [GIFS[4], GIFS[0]]);
}

#[tokio::test]
async fn a_query_it_cannot_read_is_400_and_a_limit_out_of_range_is_clamped() {
    let addr = start().await;
    for bad in ["?cursor=abc", "?cursor=-1", "?limit=x", "?limit=", "?q=%ZZ"] {
        let reply = get(addr, &format!("/v1/gifs{bad}")).await;
        assert_eq!(reply.status, 400, "{bad}");
        assert!(reply.json()["error"].is_string(), "{bad}");
        assert_eq!(reply.header("cache-control"), "no-store", "{bad}");
    }

    assert_eq!(names(&gif_page(addr, "?limit=0").await).len(), 1);
    assert_eq!(names(&gif_page(addr, "?limit=1000").await).len(), 5);
    let past = gif_page(addr, "?cursor=99").await;
    assert_eq!(names(&past), Vec::<String>::new());
    assert_eq!(past["total"], 5);
    assert_eq!(past["next"], Value::Null);
    // A key it does not know is ignored.
    assert_eq!(names(&gif_page(addr, "?limit=1&sort=new").await).len(), 1);
}

#[tokio::test]
async fn one_gif_is_answered_by_id_and_downloads() {
    let addr = start().await;
    let listed = gif_page(addr, "?limit=1").await["items"][0].clone();
    let id = listed["id"].as_str().unwrap();

    let reply = get(addr, &format!("/v1/gifs/item/{id}")).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json(), listed);

    let file = &listed["files"][0];
    let path = file["path"].as_str().unwrap();
    let encoded: String = path
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'.' {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let gif = get(addr, &file_url("gif", id, &encoded)).await;
    assert_eq!(gif.status, 200);
    assert_eq!(gif.header("content-type"), "image/gif");
    assert_eq!(
        gif.header("cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert!(gif.body.starts_with(b"GIF89a"));
    assert_eq!(gif.body.len() as u64, file["bytes"].as_u64().unwrap());
    assert_eq!(sha256(&gif.body), file["sha256"].as_str().unwrap());

    assert_eq!(get(addr, "/v1/gifs/item/gnothing").await.status, 404);
    assert_eq!(get(addr, "/v1/gifs/item/").await.status, 404);
}

#[tokio::test]
async fn gifs_are_never_listed_whole() {
    let addr = start().await;
    let reply = get(addr, "/v1/catalog/gif").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.json()["error"], "listed by /v1/gifs");
}

#[tokio::test]
async fn a_gif_that_is_not_one_costs_only_itself() {
    let (_, warnings) = load_catalog(&content());
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("not_a_gif.gif") && w.contains("not a GIF")),
        "{warnings:?}"
    );
    // README.txt beside them is not a GIF and not worth a warning.
    assert!(
        !warnings.iter().any(|w| w.contains("README.txt")),
        "{warnings:?}"
    );

    let addr = start().await;
    let everything = gif_page(addr, "?limit=100").await;
    assert!(!names(&everything)
        .iter()
        .any(|name| name.contains("not a gif")));
}

/// A content folder of its own, removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("cartcut-cloud-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("gifs")).unwrap();
        Scratch(dir)
    }

    /// Copy the fixture GIF `fixture` in under `name`.
    fn add_gif(&self, fixture: &str, name: &str) {
        std::fs::copy(
            content().join("gifs").join(fixture),
            self.0.join("gifs").join(name),
        )
        .unwrap();
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn a_name_finder_wrote_decomposed_is_found_by_the_word_typed() {
    let scratch = Scratch::new("nfd");
    // 웃음_smile.gif with 웃음 as six jamo, the way Finder can write it.
    scratch.add_gif(
        "grinning_face_smile_웃음_미소.gif",
        "\u{110B}\u{116E}\u{11BA}\u{110B}\u{1173}\u{11B7}_smile.gif",
    );
    let (addr, _) = start_on(&scratch.0).await;

    let page = gif_page(addr, "?q=%EC%9B%83%EC%9D%8C").await;
    assert_eq!(names(&page), ["웃음 smile"]);
    assert_eq!(page["items"][0]["tags"], json!(["웃음", "smile"]));
}

#[tokio::test]
async fn a_reload_serves_what_was_added_without_a_restart() {
    let scratch = Scratch::new("reload");
    scratch.add_gif("fire_hot_handwarmer_불_불꽃.gif", "fire_불.gif");
    let (addr, state) = start_on(&scratch.0).await;

    let before = gif_page(addr, "").await;
    assert_eq!(names(&before), ["fire 불"]);

    scratch.add_gif("red_heart_love_하트_사랑.gif", "heart_하트.gif");
    // Not until the reload: the folder is read once.
    assert_eq!(gif_page(addr, "").await["total"], 1);

    let (catalog, warnings) = load_catalog(&scratch.0);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(catalog.count(Kind::Gif), 2);
    state.replace(catalog);

    let after = gif_page(addr, "").await;
    assert_eq!(names(&after), ["fire 불", "heart 하트"]);
    // A new rev tells a client scrolling the old list to start again.
    assert_ne!(after["rev"], before["rev"]);
    assert_eq!(get(addr, "/v1/health").await.json()["counts"]["gif"], 2);
}
