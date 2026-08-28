### Issue for this PR

Closes #36043

### Type of change

- [x] Bug fix
- [ ] New feature
- [x] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

While streaming, the markdown projection re-parsed the entire accumulated text
on every delta, even when the previous text was unchanged and the new suffix
was small. Each re-lex is O(length), so a stream of n small deltas costs
O(n²) — the dominant cost in the TUI freeze once deltas are batched.

`project()` in `markdown-stream.ts` now grows the open `live` tail in place
instead of re-lexing, and only re-lexes when the new suffix contains a
blank-line block boundary or the raw text exceeds a 2048-char cap. A single
giant boundary-less paragraph/list/table therefore never re-parses per delta.

Because the projection lives in the shared `session-ui` package, web and
desktop also inherit the cheaper `project()` as a free performance win, even
though their per-token rendering is not the freeze described in #36043.

Complementary server-side counterpart: the V2 durable-store PR (drops
per-delta writes from the projector; `.ended` writes the authoritative text
once). Together they remove O(n²) from both ends of the stream — the client
render path here, the server write path there.

### How did you verify your code works?

- `bun test`: 26 `markdown-stream` tests (incl. a new test growing a
  boundary-less oversized tail in place without splitting) — 86 tests, 0
  failures.
- `bun typecheck` clean in `packages/session-ui`.
- `oxlint`: 0 errors.
- Micro-benchmark streaming 6–15 KB through `project()` in small deltas
  (Bun): paragraphs 1399 ms → 20 ms, single 15 KB paragraph 32345 ms → 161 ms,
  growing list 4467 ms → 60 ms.

### Screenshots / recordings

N/A — no visual change; it's a rendering-perf fix (benchmark above).

### Checklist

- [x] I have tested my changes locally
- [x] I have not included unrelated changes in this PR
