---
name: build-opencode-free-tier
description: Use when building, rebuilding, or installing the opencode binary from this repo, or when OpenCode Zen free tier models fail with "FreeTierError" / "OpenCode's free tier can only be used from within OpenCode". Covers building with the pinned Bun 1.3.14 and connecting the OpenCode Console account.
---

# Build opencode for Zen free tier

Building opencode from source in this repo has two non-obvious requirements for OpenCode Zen free tier models (`muse-spark-*-contributor-free`, `*-free`, `big-pickle`, `union-alpha`). Miss either and every free model returns:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

## Requirements

1. **Build with Bun 1.3.14.** The backend gates on the runtime version in the request
   User-Agent (`opencode/<v> ai-sdk/provider-utils/<v> runtime/bun/<v>`). Official 1.18.31
   ships `runtime/bun/1.3.14`; a build with Bun 1.4.x is rejected even though `package.json`
   pins `"packageManager": "bun@1.3.14"` (the `Script` guard uses `^1.3.14`, so 1.4.x passes
   the check but produces a rejected binary).
2. **Connect the OpenCode Console account.** The free tier is unavailable on the API-key
   path. API keys hit `https://opencode.ai/zen/v1`; a Console account routes to
   `https://opencode.ai/inference/openai/v1` with `x-opencode-org-id` and
   `OPENCODE_CONSOLE_TOKEN`.
3. **Keep the `read`, `grep`, `glob`, and `bash` tools enabled.** The free-tier gate rejects
   any request whose tool list omits one of these four built-ins — verified individually for
   each on every free model. A custom primary agent that `deny`s them (for example the
   `tokenreduce` Serena-first sandbox) produces the same FreeTierError even though the
   binary, Console account, and headers are correct. Use `"ask"` instead of `"deny"` to keep
   the tool in the request while still gating its use, and keep the prompt saying the native
   tools must not be used.

## 1. Build with Bun 1.3.14

Install the pinned Bun side-by-side and force it for the whole build (PATH prepend so the
``$`bun install ...` `` calls inside `script/build.ts` also use it):

```bash
BUN_DIR=/tmp/bun11314
rm -rf "$BUN_DIR" && mkdir -p "$BUN_DIR" && cd "$BUN_DIR"
curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip
python3 -c "import zipfile;zipfile.ZipFile('bun.zip').extractall('.')"
export PATH="$BUN_DIR/bun-linux-x64:$PATH"
bun --version   # must print 1.3.14
```

Then build from the repo root:

```bash
export OPENCODE_VERSION=1.18.31
cd packages/opencode
bun run script/build.ts --single
```

- Confirm the smoke test passes and `dist/opencode-linux-x64/bin/opencode` exists.
- `--single` builds only the host platform; drop it to build all targets.

## 2. Verify the runtime in the User-Agent

Use the bundled capture script (never `strings` the ~185 MB binary — it wedges the shell):

```bash
bun .opencode/skills/build-opencode-free-tier/scripts/verify-user-agent.ts \
  --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
```

Expected: `User-Agent: opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`.
The script exits non-zero if `runtime/bun/1.3.14` is missing.

## 3. Install the binary

```bash
cp ~/.opencode/bin/opencode ~/.opencode/bin/opencode.pre-free-tier-bak 2>/dev/null
rm -f ~/.opencode/bin/opencode            # avoids "Text file busy" on the running binary
./install --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
which opencode && opencode --version
```

Keep autoupdate disabled so the build is not downgraded on launch:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "$schema": "https://opencode.ai/config.json", "autoupdate": false }
```

## 4. Connect the Console account

`opencode auth login -p opencode` only offers an API key; the device-code flow is v2-only.
Use the bundled script, which runs the device flow and stores the account:

```bash
bun .opencode/skills/build-opencode-free-tier/scripts/connect-console-account.ts
```

- Prints a `https://opencode.ai/console/device?user_code=...` URL and code; approve it in a browser.
- On success it upserts `account` + `account_state` in
  `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`.
- `config.ts` then auto-sets `OPENCODE_CONSOLE_TOKEN` and merges the remote provider config
  on startup.

Options: `--server <url>` (default `https://opencode.ai/console`), `--db <path>`,
`--no-wait` (print the URL and exit).

## 5. Verify

```bash
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT
opencode run -m opencode/muse-spark-1.3-contributor-free "say hi in 2 words"
```

Expect a real answer (e.g. `Hi there`), not FreeTierError. Restart the TUI afterwards so it
picks up the new binary.

## Gotchas

- Rebuilding with the default Bun (1.4.x) silently breaks free tier again.
- `opencode auth login -p opencode` (API key) does not enable free tier.
- Never run `strings -a` or whole-file `grep` on the compiled binary; use the capture script.
- `account_state.active_org_id` must be set or `config.ts` will not load the Console provider config.
- A project `opencode.json` plugin can trip requirement 3: the `tokenreduce` plugin's
  `TOKENREDUCE_BUILD_AGENT`/`TOKENREDUCE_PLAN_AGENT`/`ONBOARDING_AGENT` originally denied
  `read`/`grep`/`glob`/`bash` in `/home/kronos/git/opencode-tokenreduce-plugin/src/fragments.ts`;
  they were changed to `"ask"` and rebuilt with `npm run build` there (`npm test` = 146 pass).
- `@tarquinen/opencode-dcp` is listed in this repo's `opencode.json` but is not installed in
  `node_modules`; the DCP/`compress` behavior comes from the `tokenreduce` plugin's bundled
  `dcp.js`.

## Rollback

```bash
rm -f ~/.opencode/bin/opencode && cp ~/.opencode/bin/opencode.pre-free-tier-bak ~/.opencode/bin/opencode
python3 -c "import sqlite3,os;c=sqlite3.connect(os.path.expanduser('~/.local/share/opencode/opencode.db'));c.execute('delete from account_state');c.execute('delete from account');c.commit()"
```

Remove `"autoupdate": false` from the global config to re-enable updates.

See also the Serena memory `build/free-tier-bun-runtime`.
