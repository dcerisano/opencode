#!/usr/bin/env bun
/**
 * Capture the outbound User-Agent of an opencode binary without touching the network.
 *
 * Points the `opencode` provider at a local HTTP server, runs a one-shot prompt,
 * and prints the User-Agent. Exits non-zero unless it contains `runtime/bun/1.3.14`
 * (the runtime the Zen free tier accepts).
 *
 * Usage:
 *   bun verify-user-agent.ts [--binary <path>] [--model <provider/model>] [--port <n>]
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const binary = arg("binary", "packages/opencode/dist/opencode-linux-x64/bin/opencode")
const model = arg("model", "opencode/muse-spark-1.3-contributor-free")
const port = Number(arg("port", "8899"))

let ua = ""
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    ua = req.headers.get("user-agent") ?? ua
    return new Response(JSON.stringify({ error: { message: "captured" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  },
})

const dir = mkdtempSync(join(tmpdir(), "oc-ua-"))
for (const sub of ["data", "config", "cache", "state"]) mkdirSync(join(dir, sub), { recursive: true })
const cfg = join(dir, "opencode.json")
await Bun.write(
  cfg,
  JSON.stringify({
    provider: { opencode: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" } } },
  }),
)

const proc = Bun.spawn([binary, "run", "-m", model, "hi"], {
  env: {
    ...process.env,
    OPENCODE_CONFIG: cfg,
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
  },
  stdout: "ignore",
  stderr: "ignore",
})
await Promise.race([proc.exited, Bun.sleep(30000)])
proc.kill()
server.stop(true)

if (!ua) {
  console.error("no request captured; check the --binary path")
  process.exit(1)
}
console.log(`User-Agent: ${ua}`)
process.exit(ua.includes("runtime/bun/1.3.14") ? 0 : 1)
