### Issue for this PR

Related to #36043. Picks up the follow-up deferred in #41472:

> The v2 session durable-store path (`message-updater.ts:358`) performs
> the same per-delta full-text rewrite; worth batching there separately.

### Type of change

- [x] Bug fix
- [ ] New feature
- [x] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

In the V2 projector (`packages/core/src/session/message-updater.ts`),
`session.next.text.delta` and `session.next.reasoning.delta` each did a DB
SELECT plus full-row UPDATE and O(n) string concat per token. The
corresponding `.ended` event carries the full authoritative text (since
#45831) and overwrites the part in one write, so both delta handlers become
no-ops — the same treatment `tool.input.delta` already had. The durable
store is now written exactly twice per part: `.started` appends the empty
part, `.ended` writes the final text.

This is safe because the durable row is read for context only after the step
ends, so nothing observes the intermediate state; live clients stream the
deltas directly from the event stream, not the database.

Stronger than the batching #41472 suggested: with authoritative `.ended`
events, per-delta accumulation isn't worth coalescing — it is redundant
entirely.

Known tradeoff: a crash mid-stream now persists only the empty `.started`
part; partial text is unrecoverable until `.ended` lands.

### How did you verify your code works?

- New `it.effect` test in `session-projector.test.ts`: publishes `Started`,
  three deltas, then asserts the mid-stream row still holds the empty text;
  publishes `Ended` with the full text and asserts the final row matches —
  proving deltas never touch the durable store.

### Screenshots / recordings

N/A — no visual change; it's a server-side write-amplification fix.

### Checklist

- [ ] I have tested my changes locally
- [x] I have not included unrelated changes in this PR
