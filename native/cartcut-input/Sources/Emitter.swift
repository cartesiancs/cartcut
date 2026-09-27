//
//  NDJSON on stdout, one line per event.
//
//  The same protocol `cartcut-stt` speaks, and a second copy of it on purpose:
//  the two sidecars are separate binaries built by separate `swiftc` calls with
//  no package manifest between them, so sharing forty lines would mean inventing
//  a shared module and a build graph to hold it.
//
//  stderr is deliberately left alone. dyld diagnostics and crash reports land
//  there, and mixing them into the event stream would make an unparseable line
//  indistinguishable from a real one.
//

import Foundation

/// Thread-safe: events arrive on the main run loop while the stdin watcher runs
/// on its own thread. Two half-written lines interleaved on a file descriptor is
/// a parse error at the other end, and an intermittent one.
final class Emitter: @unchecked Sendable {
  static let shared = Emitter()

  private let lock = NSLock()

  func emit(_ object: [String: Any]) {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.withoutEscapingSlashes])
    else {
      return
    }
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }

  /// Fail with a stable machine-readable code, never a bare message.
  func fail(_ code: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(exitCode)
  }
}
