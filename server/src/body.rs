//! A response body: bytes already in memory, or a file read as it is sent.
//!
//! Written by hand rather than taken from `http-body-util` and `tokio-util`,
//! which together are two crates for one enum. The file variant is what keeps
//! a 200 MB video from being read into memory before its first byte goes out.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::body::{Body as HttpBody, Bytes, Frame, SizeHint};
use tokio::fs::File;
use tokio::io::{AsyncRead, ReadBuf};

const CHUNK: usize = 64 * 1024;

pub enum Body {
    Bytes(Option<Bytes>),
    File {
        file: File,
        remaining: u64,
        buffer: Box<[u8]>,
    },
}

impl Body {
    pub fn empty() -> Body {
        Body::Bytes(None)
    }

    pub fn bytes(bytes: Bytes) -> Body {
        if bytes.is_empty() {
            Body::Bytes(None)
        } else {
            Body::Bytes(Some(bytes))
        }
    }

    /// Exactly `length` bytes of `file`, which the caller has checked it holds.
    pub fn file(file: File, length: u64) -> Body {
        Body::File {
            file,
            remaining: length,
            buffer: vec![0u8; CHUNK].into_boxed_slice(),
        }
    }
}

impl HttpBody for Body {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        match self.get_mut() {
            Body::Bytes(slot) => Poll::Ready(slot.take().map(|bytes| Ok(Frame::data(bytes)))),
            Body::File {
                file,
                remaining,
                buffer,
            } => {
                if *remaining == 0 {
                    return Poll::Ready(None);
                }
                let wanted = (*remaining).min(buffer.len() as u64) as usize;
                let mut read = ReadBuf::new(&mut buffer[..wanted]);
                match Pin::new(file).poll_read(cx, &mut read) {
                    Poll::Pending => Poll::Pending,
                    Poll::Ready(Err(error)) => Poll::Ready(Some(Err(error))),
                    Poll::Ready(Ok(())) => {
                        let filled = read.filled();
                        if filled.is_empty() {
                            // Shorter than the Content-Length already sent. Failing
                            // the stream drops the connection, which is the only
                            // honest thing left to do.
                            return Poll::Ready(Some(Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "file ended before its indexed length",
                            ))));
                        }
                        *remaining -= filled.len() as u64;
                        Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(filled)))))
                    }
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            Body::Bytes(slot) => slot.is_none(),
            Body::File { remaining, .. } => *remaining == 0,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match self {
            Body::Bytes(slot) => SizeHint::with_exact(slot.as_ref().map_or(0, |b| b.len() as u64)),
            Body::File { remaining, .. } => SizeHint::with_exact(*remaining),
        }
    }
}
