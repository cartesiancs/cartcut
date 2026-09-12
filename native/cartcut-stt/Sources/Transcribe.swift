//
//  The Speech flow: a wav in, per-word time ranges out.
//
//  Everything here is `@available(macOS 26.0, *)`. The binary itself is built
//  at a macOS 12 deployment target so it *launches* everywhere and can say why
//  it cannot work — see `main.swift`.
//

import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, *)
enum Transcribe {

  /// Resolve what the caller asked for onto a locale the transcriber actually has.
  ///
  /// `supportedLocale(equivalentTo:)` is what turns "ko" into "ko-KR", so a
  /// caller never has to know the region tag. A nil answer is a real refusal and
  /// not something to paper over with a default: transcribing Korean audio with
  /// an English model returns confident nonsense rather than an error.
  static func resolveLocale(_ identifier: String) async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
  }

  static func listLocales() async {
    let supported = await SpeechTranscriber.supportedLocales
    let installed = await SpeechTranscriber.installedLocales
    let reserved = await AssetInventory.reservedLocales
    let installedIds = Set(installed.map { $0.identifier(.bcp47) })

    Emitter.shared.emit([
      "type": "locales",
      "available": SpeechTranscriber.isAvailable,
      "supported": supported.map { locale -> [String: Any] in
        let id = locale.identifier(.bcp47)
        return [
          "id": id,
          // Endonym — the name in its own language, which is what a language
          // picker shows. `Locale.current` would label Korean "Korean" for an
          // English user and 한국어 for a Korean one; the same list either way
          // is what makes a screenshot and a support answer comparable.
          "name": locale.localizedString(forIdentifier: locale.identifier) ?? id,
          "installed": installedIds.contains(id),
        ]
      },
      "installed": installed.map { $0.identifier(.bcp47) },
      "reserved": reserved.map { $0.identifier(.bcp47) },
      "maxReserved": AssetInventory.maximumReservedLocales,
    ])
  }

  /// Download the language model if it is not already on disk.
  ///
  /// Measured here: a cold ko-KR run took 8.7s for 11s of audio and a warm one
  /// 0.44s — so essentially all of a first run's time is this download, and it
  /// is the only part that needs a progress bar.
  ///
  /// The `status` check is not redundant with the nil below.
  /// `assetInstallationRequest` hands back a *non-nil* request for a locale that
  /// is already installed; it simply completes at once. Acting on that alone
  /// made the panel flash "Downloading language model" on every single run, so
  /// the question "is it already here" has to be asked separately from "give me
  /// something that would install it".
  static func installAssetsIfNeeded(for transcriber: SpeechTranscriber) async throws {
    if await AssetInventory.status(forModules: [transcriber]) == .installed {
      return
    }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
      return
    }

    Emitter.shared.emit(["type": "assets", "phase": "downloading", "fraction": 0])

    // `Progress` is KVO, and the observation has to outlive this scope or it
    // stops reporting the moment the token is released.
    let observation = request.progress.observe(\.fractionCompleted) { progress, _ in
      Emitter.shared.emit([
        "type": "assets",
        "phase": "downloading",
        "fraction": progress.fractionCompleted,
      ])
    }
    defer { observation.invalidate() }

    try await request.downloadAndInstall()
    Emitter.shared.emit(["type": "assets", "phase": "done", "fraction": 1])
  }

  /// Words, with the time range each one occupies in the file.
  static func run(inputPath: String, localeIdentifier: String) async throws {
    guard SpeechTranscriber.isAvailable else {
      Emitter.shared.fail("unavailable", "Speech transcription is not available on this Mac.")
    }
    guard let locale = await resolveLocale(localeIdentifier) else {
      Emitter.shared.fail(
        "unsupported_locale",
        "\(localeIdentifier) is not one of the languages this Mac can transcribe.")
    }

    let url = URL(fileURLWithPath: inputPath)
    guard FileManager.default.fileExists(atPath: inputPath) else {
      Emitter.shared.fail("no_input", "No such audio file: \(inputPath)")
    }

    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      // No `.volatileResults`: a file has no partial guesses worth showing, and
      // volatile results would make the same word arrive several times and have
      // to be de-duplicated by range at the other end.
      reportingOptions: [],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence])

    try await installAssetsIfNeeded(for: transcriber)

    // Best effort. Reserving pins the model against the OS purging it, so the
    // next run in this language stays warm — but the cap is small and hitting
    // it is not a reason to refuse to transcribe.
    _ = try? await AssetInventory.reserve(locale: locale)

    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      Emitter.shared.fail("audio_read_failed", "Could not read \(inputPath): \(error.localizedDescription)")
    }
    let duration = Double(file.length) / file.fileFormat.sampleRate

    let analyzer = SpeechAnalyzer(modules: [transcriber])

    let consumer = Task {
      var lastPercent = -1
      for try await result in transcriber.results {
        emitWords(of: result)

        // Real progress: how far into the file the recogniser has committed,
        // not a timer. Whole percents only — at one line per word a long file
        // would otherwise spend more bytes on progress than on words.
        if duration > 0 {
          let percent = Int((result.range.end.seconds / duration * 100).rounded(.down))
          if percent != lastPercent {
            lastPercent = percent
            Emitter.shared.emit(["type": "progress", "fraction": Double(percent) / 100])
          }
        }
      }
    }

    // `analyzeSequence` returns when the file has been read, but the tail may
    // still be in flight — which is why a finish call is mandatory. Letting the
    // input end without one leaves `results` open forever and the process hangs
    // instead of failing, the worst failure mode of the three.
    let last = try await analyzer.analyzeSequence(from: file)
    if let last {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    }
    try await consumer.value

    Emitter.shared.emit(["type": "done", "locale": locale.identifier(.bcp47)])
  }

  /// One event per word.
  ///
  /// The timings live on the **runs of the attributed string**, not on
  /// `Result.range` — that is the whole segment. Reading `Result.range` instead
  /// yields one pseudo-word per sentence, which is precisely the defect the
  /// OpenAI back end has and the reason this feature exists.
  private static func emitWords(of result: SpeechTranscriber.Result) {
    for run in result.text.runs {
      guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else {
        continue
      }
      let text = String(result.text[run.range].characters)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        continue
      }

      var event: [String: Any] = [
        "type": "word",
        "word": text,
        "startMs": Int((range.start.seconds * 1000).rounded()),
        "endMs": Int((range.end.seconds * 1000).rounded()),
      ]
      if let confidence = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] {
        event["confidence"] = confidence
      }
      Emitter.shared.emit(event)
    }
  }
}
