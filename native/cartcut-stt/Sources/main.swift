//
//  cartcut-stt — on-device speech-to-text for Cartcut, with word timings.
//
//    cartcut-stt locales
//    cartcut-stt transcribe --input <wav> --locale <bcp47>
//
//  Spawned by the Electron main process the way ffmpeg is, and for the same
//  reason: the Speech framework wants a Swift concurrency runtime and an async
//  result stream, which is natural in a process and awkward across a N-API
//  boundary — and a framework crash here cannot take the editor down with it.
//
//  **Built at a macOS 12 deployment target on purpose.** Everything it actually
//  uses is macOS 26, but a binary built with `-target …macos26.0` fails at
//  `exec` on an older system with a dyld diagnostic on stderr, which the caller
//  cannot tell apart from a missing binary. At 12.0 the Speech symbols are weak
//  imports, `if #available` never touches them, and the process launches and
//  says `requires_macos_26` in the same NDJSON everything else speaks.
//

import Foundation

/// `--name value` pairs. Deliberately tiny: ArgumentParser would be a package
/// dependency, and `scripts/buildSpeech.mjs` is two `swiftc` calls with no
/// package manifest and nothing to resolve.
func flag(_ name: String, _ args: [String]) -> String? {
  guard let index = args.firstIndex(of: "--\(name)"), index + 1 < args.count else {
    return nil
  }
  return args[index + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first

// The version gate is here rather than inside each command so there is exactly
// one place that knows the requirement, and so `locales` can answer it too —
// the panel asks `locales` first and disables the On-device button on this.
//
// `if` and not `guard`: at file scope a `guard ... else { exit }` does not
// narrow the availability of what follows, so every use below would still need
// its own check.
if #available(macOS 26.0, *) {
  await dispatch(command: command, args: args)
} else {
  Emitter.shared.emit([
    "type": command == "locales" ? "locales" : "error",
    "available": false,
    "code": "requires_macos_26",
    "message": "On-device transcription needs macOS 26 or later.",
  ])
  // Exit 0: "this Mac is too old" is an answer, not a failure to produce one.
  exit(0)
}

@available(macOS 26.0, *)
func dispatch(command: String?, args: [String]) async {
  switch command {
  case "locales":
    await Transcribe.listLocales()

  case "transcribe":
    guard let input = flag("input", args) else {
      Emitter.shared.fail("usage", "transcribe needs --input <wav>", exitCode: 2)
    }
    let locale = flag("locale", args) ?? Locale.current.identifier
    do {
      try await Transcribe.run(inputPath: input, localeIdentifier: locale)
    } catch is CancellationError {
      Emitter.shared.fail("cancelled", "Transcription was cancelled.")
    } catch {
      let nsError = error as NSError
      Emitter.shared.fail(
        "transcription_failed",
        "\(error.localizedDescription) [\(nsError.domain) \(nsError.code)]")
    }

  default:
    Emitter.shared.fail(
      "usage",
      "Usage: cartcut-stt locales | cartcut-stt transcribe --input <wav> --locale <bcp47>",
      exitCode: 2)
  }
}
