//
//  cartcut-input: what the mouse did, and when, for auto-zoom.
//
//    cartcut-input watch              stream until stdin closes
//    cartcut-input probe --seconds 5  stream, then report a count, then exit
//
//  Spawned by the Electron main process alongside the cursor sampler in
//  `electron/lib/recordSession.ts`. It exists for one reason: no Electron or
//  renderer API can see a click that lands in another application.
//  `screen.getCursorScreenPoint()` answers where the pointer is with no
//  permission and no native code, and there is no equivalent for a button.
//
//  ## It emits no coordinates, deliberately
//
//  A click's position *is* the pointer's position at that instant, and main
//  already has an exact, tested mapping from a screen point into capture frame
//  pixels. That is `sampleCursor`'s, which goes through the display's `bounds` rather
//  than its `scaleFactor` so it needs no separate case for a fractional Windows
//  factor, and which drops a point on another screen rather than clamping it.
//
//  Emitting our own would mean reproducing that mapping from Cocoa's global
//  coordinate space, whose origin is the *bottom* left of the primary display
//  with y increasing upward, against Electron's, whose origin is the top left
//  with y increasing downward. The two differ by a flip about the primary
//  display's top edge, which is correct on one monitor and a class of bug on
//  three, in a direction no node suite can see.
//
//  So this says *what* and main says *where*. One geometry, in the place that
//  already had it.
//
//  ## And no keycodes, now or ever
//
//  There is no key monitor here at all. When typing is added as a zoom trigger
//  it will report that *a* key went down and nothing more: a camera planner has
//  no use for the identity of a key, and writing one to disk beside a recording
//  would make this a keylogger. Mouse monitors also need no permission, where
//  Apple documents key monitors as requiring accessibility trust, which is why
//  clicks ship first and typing does not.
//

import AppKit
import Foundation

func flag(_ name: String, _ args: [String]) -> String? {
  guard let index = args.firstIndex(of: "--\(name)"), index + 1 < args.count else {
    return nil
  }
  return args[index + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first

guard command == "watch" || command == "probe" else {
  Emitter.shared.fail("usage", "expected `watch` or `probe --seconds <n>`", exitCode: 2)
}

/// A count, for `probe` and for the dev log. Only ever touched on the main run
/// loop, where every monitor callback lands.
final class Counter {
  var value = 0
}
let counter = Counter()

let monitored: NSEvent.EventTypeMask = [
  .leftMouseDown, .rightMouseDown, .otherMouseDown,
  .leftMouseUp, .rightMouseUp, .otherMouseUp,
  .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
  .scrollWheel,
]

/// What main is told. A drag and a scroll are separate kinds rather than a
/// modifier on a move because the planner treats them differently: a drag
/// extends a segment along its path, a scroll is an anchor where it happened.
func kindOf(_ type: NSEvent.EventType) -> String? {
  switch type {
  case .leftMouseDown, .rightMouseDown, .otherMouseDown: return "down"
  case .leftMouseUp, .rightMouseUp, .otherMouseUp: return "up"
  case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: return "drag"
  case .scrollWheel: return "scroll"
  default: return nil
  }
}

// `.prohibited` rather than `.accessory`: no Dock tile, no menu bar, nothing
// focusable. A global monitor still needs a window server connection and a run
// loop, which an `NSApplication` at this policy has and a bare CLI does not.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let monitor = NSEvent.addGlobalMonitorForEvents(matching: monitored) { event in
  guard let kind = kindOf(event.type) else {
    return
  }
  counter.value += 1
  Emitter.shared.emit(["type": "event", "kind": kind, "button": event.buttonNumber])
}

// Reported rather than required. Mouse monitors are expected to work with
// neither of these, and the caller logs the pair so a machine where they turn
// out to be necessary says so in the one place somebody would look.
Emitter.shared.emit([
  "type": "ready",
  "installed": monitor != nil,
  "trusted": AXIsProcessTrusted(),
])

/// Exit when the parent does.
///
/// Main kills this on stop, but a crash between spawn and kill would otherwise
/// leave a process watching every click on the machine with nobody listening. A
/// closed stdin is the one signal that cannot be missed.
let stdinWatcher = Thread {
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty {
      exit(0)
    }
  }
}
stdinWatcher.start()

if command == "probe" {
  let seconds = Double(flag("seconds", args) ?? "5") ?? 5
  DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
    Emitter.shared.emit([
      "type": "probe",
      "events": counter.value,
      "seconds": seconds,
      "trusted": AXIsProcessTrusted(),
    ])
    exit(0)
  }
}

app.run()
