//! The request log: one line per request, in one file per UTC day
//! (`requests-2026-10-26.log`), never on the console.
//!
//! A request only sends its line down a channel. A thread of its own does the
//! disk work, so a slow or full disk never holds a response.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct RequestLog {
    lines: Sender<(u64, String)>,
}

impl RequestLog {
    /// Creates `dir` if needed and starts the writer thread.
    pub fn open(dir: impl Into<PathBuf>) -> io::Result<RequestLog> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let (lines, received) = mpsc::channel();
        thread::Builder::new()
            .name("request-log".into())
            .spawn(move || write_lines(&dir, received))?;
        Ok(RequestLog { lines })
    }

    /// Stamped here rather than in the writer, so a backlog does not shift a
    /// line's time or push it into the next day's file.
    pub fn record(&self, line: String) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        // A send fails only once the writer thread is gone, and it never
        // returns while the sender is alive.
        let _ = self.lines.send((now, line));
    }
}

/// The file for one day, or `None` for a day whose file would not open, so a
/// bad directory costs one console line per day instead of one per request.
struct Day {
    date: String,
    file: Option<BufWriter<File>>,
    /// Set by a failed write and cleared by the next good one, so a full disk
    /// reports once rather than once per line.
    failing: bool,
}

fn write_lines(dir: &Path, received: Receiver<(u64, String)>) {
    let mut day: Option<Day> = None;
    // Block for one line, take whatever else is already queued, then flush:
    // a burst is one write, and a quiet server's file is never behind.
    while let Ok(first) = received.recv() {
        let mut next = Some(first);
        while let Some((secs, line)) = next {
            let date = date_of(secs);
            if day.as_ref().map_or(true, |day| day.date != date) {
                if let Some(Day {
                    file: Some(mut file),
                    ..
                }) = day.take()
                {
                    let _ = file.flush();
                }
                day = Some(open_day(dir, date));
            }
            if let Some(day) = day.as_mut() {
                if let Some(file) = day.file.as_mut() {
                    let written = writeln!(file, "{} {line}", timestamp_of(secs));
                    note(day, written);
                }
            }
            next = received.try_recv().ok();
        }
        if let Some(day) = day.as_mut() {
            if let Some(file) = day.file.as_mut() {
                let flushed = file.flush();
                note(day, flushed);
            }
        }
    }
}

fn open_day(dir: &Path, date: String) -> Day {
    let path = dir.join(format!("requests-{date}.log"));
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => Some(BufWriter::new(file)),
        Err(error) => {
            eprintln!(
                "cannot open {}: {error}; requests go unlogged until the next day",
                path.display()
            );
            None
        }
    };
    Day {
        date,
        file,
        failing: false,
    }
}

fn note(day: &mut Day, result: io::Result<()>) {
    match result {
        Ok(()) => day.failing = false,
        Err(error) => {
            if !day.failing {
                eprintln!("cannot write the request log: {error}");
            }
            day.failing = true;
        }
    }
}

/// `2026-10-26`, in UTC.
fn date_of(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `2026-10-26T03:12:45Z`.
fn timestamp_of(secs: u64) -> String {
    let rest = secs % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        date_of(secs),
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// `civil_from_days`), so a date needs no dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_match_the_calendar() {
        assert_eq!(timestamp_of(0), "1970-01-01T00:00:00Z");
        // A leap day, and the second before it.
        assert_eq!(timestamp_of(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(timestamp_of(951_782_399), "2000-02-28T23:59:59Z");
        assert_eq!(timestamp_of(1_793_017_965), "2026-10-26T12:32:45Z");
        assert_eq!(date_of(4_107_542_399), "2100-02-28");
        // 2100 is not a leap year.
        assert_eq!(date_of(4_107_542_400), "2100-03-01");
    }

    #[test]
    fn a_new_day_starts_a_new_file() {
        let dir = std::env::temp_dir().join(format!("cartcut-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let (lines, received) = mpsc::channel();
        lines
            .send((1_793_059_199, "GET /a 200 1.0ms".to_string()))
            .unwrap();
        lines
            .send((1_793_059_200, "GET /b 404 0.5ms".to_string()))
            .unwrap();
        lines
            .send((1_793_059_201, "GET /c 200 0.7ms".to_string()))
            .unwrap();
        drop(lines);
        write_lines(&dir, received);

        let first = fs::read_to_string(dir.join("requests-2026-10-26.log")).unwrap();
        let second = fs::read_to_string(dir.join("requests-2026-10-27.log")).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(first, "2026-10-26T23:59:59Z GET /a 200 1.0ms\n");
        assert_eq!(
            second,
            "2026-10-27T00:00:00Z GET /b 404 0.5ms\n2026-10-27T00:00:01Z GET /c 200 0.7ms\n"
        );
    }
}
