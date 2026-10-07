import { describe, expect, test } from "bun:test"
import { createDeltaBuffer, type PendingDelta } from "../src/solid/delta-buffer"

function makeBuffer() {
  const applied: PendingDelta[] = []
  const scheduled: Array<() => void> = []
  const buffer = createDeltaBuffer(
    (flush) => scheduled.push(flush),
    (item) => applied.push(item),
  )
  return { buffer, applied, scheduled }
}

const base = { sessionID: "s", messageID: "m" } as const

describe("createDeltaBuffer", () => {
  test("concatenates same-key deltas into one apply and schedules one flush per burst", () => {
    const { buffer, applied, scheduled } = makeBuffer()

    buffer.push({ kind: "reasoning", ...base, partID: "r1", delta: "a" })
    buffer.push({ kind: "reasoning", ...base, partID: "r1", delta: "b" })
    buffer.push({ kind: "reasoning", ...base, partID: "r1", delta: "c" })

    expect(applied).toEqual([])
    expect(scheduled).toHaveLength(1)
    scheduled.shift()!()
    expect(applied).toEqual([{ kind: "reasoning", ...base, partID: "r1", delta: "abc" }])
  })

  test("keeps distinct keys separate within one flush", () => {
    const { buffer, applied, scheduled } = makeBuffer()

    buffer.push({ kind: "reasoning", ...base, partID: "r1", delta: "a" })
    buffer.push({ kind: "text", ...base, partID: "t1", delta: "x" })
    buffer.push({ kind: "reasoning", ...base, partID: "r1", delta: "b" })
    buffer.push({ kind: "tool", ...base, partID: "t1", delta: "y" })

    scheduled.shift()!()
    expect(applied).toEqual([
      { kind: "reasoning", ...base, partID: "r1", delta: "ab" },
      { kind: "text", ...base, partID: "t1", delta: "x" },
      { kind: "tool", ...base, partID: "t1", delta: "y" },
    ])
  })

  test("applies nothing until the scheduled flush runs", () => {
    const { buffer, applied, scheduled } = makeBuffer()

    buffer.push({ kind: "text", ...base, partID: "t1", delta: "a" })
    expect(applied).toEqual([])
    expect(scheduled).toHaveLength(1)

    scheduled.shift()!()
    expect(applied).toEqual([{ kind: "text", ...base, partID: "t1", delta: "a" }])
  })

  test("drain applies immediately and a later scheduled flush is a no-op", () => {
    const { buffer, applied, scheduled } = makeBuffer()

    buffer.push({ kind: "text", ...base, partID: "t1", delta: "a" })
    buffer.drain()
    expect(applied).toEqual([{ kind: "text", ...base, partID: "t1", delta: "a" }])

    scheduled.shift()!()
    expect(applied).toEqual([{ kind: "text", ...base, partID: "t1", delta: "a" }])
  })

  test("drop removes matching pending deltas while unrelated entries still apply", () => {
    const { buffer, applied, scheduled } = makeBuffer()

    buffer.push({ kind: "text", ...base, partID: "t1", delta: "a" })
    buffer.push({ kind: "text", ...base, partID: "t2", delta: "b" })
    buffer.drop((item) => item.partID === "t1")

    scheduled.shift()!()
    expect(applied).toEqual([{ kind: "text", ...base, partID: "t2", delta: "b" }])
  })
})
