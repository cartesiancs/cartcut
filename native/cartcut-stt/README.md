# cartcut-stt

On-device speech-to-text for Cartcut, with per-word timings. A small Swift CLI
over macOS 26's `SpeechAnalyzer` / `SpeechTranscriber`, spawned by the Electron
main process the way `ffmpeg` is.

## Build

```
npm run build:speech          # host arch, into bin/<platform>-<arch>/
node scripts/buildSpeech.mjs --all   # both macOS slices, what build:osx runs
```

`npm run dev` runs the first of these. The build skips itself, with a message,
on Windows or without the macOS 26 SDK; it fails hard if the SDK is there and
the compile breaks, because a DMG quietly missing the feature is worse.

By hand:

```
xcrun --sdk macosx swiftc -O -wmo -swift-version 6 \
  -target arm64-apple-macos12.0 -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -framework Speech -framework AVFoundation \
  -o bin/darwin-arm64/cartcut-stt Sources/*.swift
```

The macOS **12** deployment target is deliberate even though every API used is
macOS 26 — see CLAUDE.md, "On-device speech-to-text".

## Use

```
cartcut-stt locales
cartcut-stt transcribe --input <wav> --locale ko-KR
```

One JSON object per line on stdout; stderr is left for dyld and crash output.

```
{"type":"locales","available":true,"supported":[{"id":"ko-KR","name":"한국어(대한민국)","installed":true}],…}
{"type":"assets","phase":"downloading","fraction":0.42}
{"type":"progress","fraction":0.31}
{"type":"word","word":"안녕하세요.","startMs":0,"endMs":840,"confidence":0.94}
{"type":"done","locale":"ko-KR"}
{"type":"error","code":"unsupported_locale","message":"…"}
```

It takes a **wav**, not arbitrary media: `electron/mcp/transcribe.ts` already
extracts 16 kHz mono with ffmpeg, which handles every container and codec and
keeps this to `AVAudioFile` and nothing else.

`--locale` is matched with `SpeechTranscriber.supportedLocale(equivalentTo:)`,
so `ko` finds `ko-KR`. A language this Mac cannot transcribe is an error and not
a fallback: transcribing Korean with an English model returns confident nonsense.

The language models are downloaded and owned by the OS through `AssetInventory`.
Nothing ships one.
