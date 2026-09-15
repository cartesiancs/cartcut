## What this changes

<!-- One or two sentences. A reviewable change does one thing. -->

## How it was checked

- [ ] `npm test`
- [ ] `npx tsc --noEmit -p ./.tsconfig` (main process)
- [ ] `npx webpack --mode=development` (the renderer, which webpack typechecks)

## Checklist

- [ ] Opened against `main`.
- [ ] New pure logic has a co-located suite covering the decline path, where the
      op returns its input by identity, as well as the happy one.
- [ ] `main/`, `dist/` and `bin/` are untouched. All three are gitignored build
      output.
- [ ] `SCHEMA_VERSION` did not move, or the description says why it had to.
- [ ] Commit messages follow Conventional Commits, comments, docs, UI strings or the messages.

## Related issues

<!-- Closes #123, or "none" for a small fix. Anything larger than a small fix
should have an issue first. -->
