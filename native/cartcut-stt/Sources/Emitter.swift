//
//  NDJSON on stdout, one line per event.
//
//  A line rather than one JSON document at the end because the caller wants
//  progress while a ten-minute file is being read, and NDJSON needs no framing:
//  `electron/lib/speechStt.ts` splits on "\n" exactly the way
//  `reversePipeline.ts#runFfmpeg` reads ffmpeg's `-progress pipe:1`.
//
//  stderr is deliberately left alone. dyld diagnostics and crash reports land
//  there, and mixing them into the event stream would make an unparseable line
//  indistinguishable from a failed transcription.
//

import Foundation

/// Thread-safe because words are emitted from the results task while asset
/// progress is emitted from a KVO callback on another queue. Two half-written
/// lines interleaved on a file descriptor is a parse error at the other end,
/// and an intermittent one.
final class Emitter: @unchecked Sendable {
  static let shared = Emitter()

  private let lock = NSLock()

  func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else {
      return
    }
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }

  /// Fail with a stable machine-readable code, never a bare message.
  ///
  /// The renderer turns these into sentences a user can act on — "the model for
  /// this language is still downloading" is a different instruction from "this
  /// language is not supported" — so the distinction has to survive the pipe.
  func fail(_ code: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(exitCode)
  }
}
