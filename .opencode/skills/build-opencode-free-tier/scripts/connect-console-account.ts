#!/usr/bin/env bun
/**
 * Connect an OpenCode Console account for Zen free tier.
 *
 * Runs the device-code OAuth flow (client_id "opencode-cli") and persists the
 * account so config.ts can auto-set OPENCODE_CONSOLE_TOKEN and merge the remote
 * provider config (`https://opencode.ai/inference/openai/v1`).
 *
 * Usage:
 *   bun connect-console-account.ts [--server <url>] [--db <path>] [--no-wait]
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const server = (arg("server", "https://opencode.ai/console") ?? "").replace(/\/+$/, "")
const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
const dbPath = arg("db", join(dataDir, "opencode.db"))!
const clientId = "opencode-cli"
const userAgent = "opencode/1.18.31 cli"

async function post(path: string, body: unknown) {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }
}

async function get(path: string, token: string) {
  const res = await fetch(`${server}${path}`, {
    headers: { "user-agent": userAgent, authorization: `Bearer ${token}` },
  })
  return (await res.json().catch(() => ({}))) as any
}

const code = await post("/auth/device/code", { client_id: clientId })
if (code.status >= 400 || !code.body.device_code) {
  console.error("device/code failed:", code.status, code.body)
  process.exit(1)
}

const verificationUrl = new URL(code.body.verification_uri_complete, `${server}/`).href
console.log(`\nApprove this request in your browser:\n  ${verificationUrl}\n  code: ${code.body.user_code}\n`)
if (args.includes("--no-wait")) process.exit(0)

const interval = Math.max(1, Number(code.body.interval) || 5)
const deadline = Date.now() + (Number(code.body.expires_in) || 900) * 1000
let token: { access_token: string; refresh_token: string; expires_in?: number } | undefined
while (Date.now() < deadline) {
  await Bun.sleep(interval * 1000)
  const res = await post("/auth/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.body.device_code,
    client_id: clientId,
  })
  if (res.body.access_token) {
    token = res.body as typeof token
    break
  }
  if (res.body.error === "authorization_pending" || res.body.error === "slow_down") continue
  console.error("device/token failed:", res.status, res.body)
  process.exit(1)
}
if (!token) {
  console.error("timed out waiting for browser approval")
  process.exit(1)
}

const user = await get("/api/user", token.access_token)
const orgs = await get("/api/orgs", token.access_token)
const org = Array.isArray(orgs) ? orgs[0] : undefined
if (!user?.id) {
  console.error("failed to load account:", user)
  process.exit(1)
}
console.log(`signed in as ${user.email ?? user.id}${org ? ` (org: ${org.name})` : ""}`)

mkdirSync(dataDir, { recursive: true })
const db = new Database(dbPath)
db.run(`create table if not exists account (
  id text primary key,
  email text not null,
  url text not null,
  access_token text not null,
  refresh_token text not null,
  token_expiry integer,
  time_created integer,
  time_updated integer
)`)
db.run(`create table if not exists account_state (
  id integer primary key,
  active_account_id text,
  active_org_id text
)`)

const now = Date.now()
const expiry = now + (Number(token.expires_in) || 0) * 1000
db.query(
  `insert into account (id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated)
   values (?,?,?,?,?,?,?,?)
   on conflict(id) do update set email=excluded.email, url=excluded.url, access_token=excluded.access_token,
     refresh_token=excluded.refresh_token, token_expiry=excluded.token_expiry, time_updated=excluded.time_updated`,
).run(user.id, user.email ?? "", server, token.access_token, token.refresh_token, expiry, now, now)
db.query(
  `insert into account_state (id,active_account_id,active_org_id) values (1,?,?)
   on conflict(id) do update set active_account_id=excluded.active_account_id, active_org_id=excluded.active_org_id`,
).run(user.id, org?.id ?? null)
db.close()

console.log(`stored Console account in ${dbPath}`)
console.log("Restart opencode to pick it up.")
