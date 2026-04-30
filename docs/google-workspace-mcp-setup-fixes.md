# Google Workspace MCP Setup — Fix Log

Chronological record of every issue hit and fix applied during the session that got
`@aaronsb/google-workspace-mcp` working inside Saul's agent container (April 29 2026).

---

## 1. Agent-to-Agent Destinations Not Wired

**Symptom:** Saul said "I don't have any other agents wired up" even though Jean Luc,
Morgan, and Victor were already registered in the database.

**Root cause:** `agent_destinations` rows in `data/v2.db` were missing.
The `restore-agents.sh` script had only inserted the agent groups — the bidirectional
wiring between Saul and the other agents was never written.

**Fix:** Ran `wire-agent-destinations.sh`, which inserted six rows into
`agent_destinations` (Saul → Jean Luc, Morgan, Victor; each of them → Saul as `parent`).

---

## 2. Service Name Was Wrong for Restart

**Symptom:** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` returned exit 113
("service not found").

**Root cause:** The installed service label is `com.nanoclaw-v2-95375b94`, not `com.nanoclaw`.

**Fix:**
```bash
launchctl list | grep -i nano          # reveals: com.nanoclaw-v2-95375b94
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-95375b94
```

---

## 3. Stale Session Continuation Poisoning Responses

**Symptom:** Even after wiring the destinations and restarting NanoClaw, Saul kept
replying "I have no other agents wired up." The same happened after the Google Workspace
MCP was added — Saul kept saying "no Google account connected."

**Root cause:** Claude Code's `resume` flag re-enters an existing conversation thread
(keyed by the `continuation:claude` row in `outbound.db`). The old session had prior
context ("no agents / no Google") that overrode the updated system prompt.

**Fix:** Delete the continuation row from the session's `outbound.db`:
```bash
SESS_DIR="data/v2-sessions/ag-1777520861575-n3h33w/sess-1777520861579-y4b96r"
sqlite3 "$SESS_DIR/outbound.db" "DELETE FROM session_state WHERE key LIKE 'continuation:%';"
```

This forces a clean session on the next message so Claude reads the current system prompt fresh.

> **Note:** This is also what `/clear` does when typed in chat — it's equivalent.

---

## 4. `VAULT:` Prefix Not Resolved by Container Runner

**Symptom:** MCP server started but OAuth flow immediately failed — the server was
receiving the literal string `"VAULT:google_client_id"` as the client ID.

**Root cause:** `container.json` env values prefixed with `VAULT:` are **not** resolved
by `src/container-runner.ts`. That notation is not a NanoClaw or OneCLI feature —
it was hallucinated by Saul when he wrote the `add_mcp_server` request.
`container-runner.ts` passes env vars verbatim; OneCLI only injects into HTTP headers.

**Fix:** Replace the `VAULT:` placeholders with the real credential values directly in
`groups/dm-with-saul/container.json`.

---

## 5. OAuth Error 400: redirect_uri_mismatch

**Symptom:** Opening the Google consent URL showed:
`Access blocked: Error 400: redirect_uri_mismatch`

**Root cause (inferred):** The first OAuth 2.0 client did not permit the loopback
redirect URI that `@aaronsb/google-workspace-mcp` requests. The server starts a callback
listener on a random port (`http://127.0.0.1:PORT/callback`) and needs the OAuth client
to allow arbitrary loopback redirects. The exact type of the first credential was never
confirmed — the `redirect_uri_mismatch` error is consistent with a **Web application**
client (which requires exact pre-registered URIs) but could also occur with a Desktop app
that has unusual restrictions or stale configuration.

**What was tried:** The error message was diagnosed as a likely Web app / redirect URI
mismatch. Rather than attempting to fix the original credential (e.g., by adding
`http://127.0.0.1` to its authorized redirect URIs), a new credential was created from
scratch as a **Desktop app** type.

**Fix:** Use a **Desktop app** OAuth 2.0 client. Desktop app clients automatically allow
any `http://127.0.0.1` loopback redirect on any port without pre-registration. The second
set of credentials (explicitly confirmed Desktop app type) succeeded immediately.

---

## 6. OAuth Flow Cannot Run Inside a Docker Container

**Symptom:** The MCP server inside the container opened a browser OAuth flow, but it
timed out after 5 minutes. The browser redirect goes to
`http://127.0.0.1:PORT/callback` — the **container's** loopback — which is unreachable
from the user's browser on the host.

**Root cause:** Docker containers have their own network namespace. The random-port
localhost callback server the MCP starts is inaccessible from outside the container.

**Fix:** Run the OAuth flow once on the **host Mac** (where a real browser exists),
store the resulting tokens in a host directory, then mount that directory into the
container:

```bash
mkdir -p "$HOME/.google-workspace-mcp/config" "$HOME/.google-workspace-mcp/data"
XDG_CONFIG_HOME="$HOME/.google-workspace-mcp/config" \
XDG_DATA_HOME="$HOME/.google-workspace-mcp/data" \
  node /tmp/gws-auth.mjs "<CLIENT_ID>" "<CLIENT_SECRET>"
```

The helper script (`/tmp/gws-auth.mjs`) starts the MCP server, sends a
`manage_accounts authenticate` JSON-RPC call, and waits for the browser flow to complete.
Tokens land at:
- `~/.google-workspace-mcp/config/google-workspace-mcp/accounts.json`
- `~/.google-workspace-mcp/data/google-workspace-mcp/credentials/hector_at_develom_dot_com.json`

---

## 7. `additionalMounts` Silently Blocked by Allowlist

**Symptom:** `~/.google-workspace-mcp` was configured in `container.json`
`additionalMounts` but the container had no `/workspace/extra/.google-workspace-mcp`
directory. The mount was silently dropped.

**Root cause:** NanoClaw's mount security module validates every additional mount against
`~/.config/nanoclaw/mount-allowlist.json`. If the host path is not under an
`allowedRoots` entry the mount is rejected and logged as a warning — but the container
still starts without it.

**Fix:** Add the path to the allowlist:

```json
// ~/.config/nanoclaw/mount-allowlist.json
{
  "allowedRoots": [
    ...
    {
      "path": "/Users/hd/.google-workspace-mcp",
      "allowReadWrite": true,
      "description": "Google Workspace MCP credentials and tokens"
    }
  ]
}
```

Then restart NanoClaw — the allowlist is cached in-process and only reloaded on startup.

> **Note:** The `credentials` string in the token subdirectory path
> (`data/google-workspace-mcp/credentials/`) does NOT trigger the default blocked
> patterns because blocking is checked against the **mount point** (the host path),
> not its subdirectories.

---

## 8. `pnpm dlx` Too Slow — MCP Server Timed Out Before Initializing

**Symptom:** Claude processed the first message before the MCP server finished starting.
The container log showed `[agent-runner] Additional MCP server: google-workspace (npx)`
but no `[gws-mcp] startup: 11 tools loaded` line — the npx download was still in
progress when Claude began its query.

**Root cause:** `pnpm dlx @aaronsb/google-workspace-mcp` (and equivalently `npx`)
downloads the package on every container start. Inside the container this takes
30–60 seconds. The Claude Agent SDK's MCP initialization timeout fires before the
package is ready.

**Fix:** Pre-install the package in the container image so it's available instantly:

```dockerfile
# container/Dockerfile
ARG GOOGLE_WORKSPACE_MCP_VERSION=2.6.1
ARG GOOGLEWORKSPACE_CLI_VERSION=0.22.5

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=@googleworkspace/cli" >> /root/.npmrc && \
    pnpm install -g \
        "@googleworkspace/cli@${GOOGLEWORKSPACE_CLI_VERSION}" \
        "@aaronsb/google-workspace-mcp@${GOOGLE_WORKSPACE_MCP_VERSION}"
```

Update `container.json` to use the pre-installed binary:
```json
"command": "google-workspace-mcp",
"args": []
```

---

## 9. `gws` CLI Binary Not in PATH

**Symptom:** After the image rebuild, Saul reported: `"the Google Workspace tool is
missing a required binary (gws CLI)"`. `which gws` inside the container returned nothing.

**Root cause:** `@aaronsb/google-workspace-mcp` depends on `@googleworkspace/cli`, which
provides the `gws` binary. When installed as a **transitive** dependency, pnpm does not
symlink its binary into `/pnpm/` (the `PNPM_HOME` on the container's `$PATH`). Only
direct global packages get their bins linked there.

The binary existed at
`/pnpm/global/5/.pnpm/node_modules/.bin/gws` but that path is not on `$PATH`.

**Fix:** Install `@googleworkspace/cli` as an **explicit** global package alongside
`@aaronsb/google-workspace-mcp` in the same Dockerfile `RUN` step (see fix 8 above).
This forces pnpm to link `gws` into `/pnpm/`, which is on `$PATH`.

---

## Final Working Configuration

### `groups/dm-with-saul/container.json`
```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "google-workspace-mcp",
      "args": [],
      "env": {
        "GOOGLE_CLIENT_ID": "<desktop-app-client-id>",
        "GOOGLE_CLIENT_SECRET": "<desktop-app-client-secret>",
        "XDG_CONFIG_HOME": "/workspace/extra/.google-workspace-mcp/config",
        "XDG_DATA_HOME": "/workspace/extra/.google-workspace-mcp/data"
      }
    }
  },
  "additionalMounts": [
    {
      "hostPath": "/Users/hd/.google-workspace-mcp",
      "containerPath": ".google-workspace-mcp",
      "readonly": false
    }
  ]
}
```

### Token persistence
OAuth tokens are stored on the host at `~/.google-workspace-mcp/` and mounted
read-write into the container at `/workspace/extra/.google-workspace-mcp/`.
The XDG env vars point the MCP server at the mounted path, so tokens survive container
restarts and rebuilds. Re-authentication is only needed if tokens are revoked or expired.

### Re-authenticating in the future
If tokens expire, run the auth helper again on the host (not inside a container):
```bash
XDG_CONFIG_HOME="$HOME/.google-workspace-mcp/config" \
XDG_DATA_HOME="$HOME/.google-workspace-mcp/data" \
npx --yes @aaronsb/google-workspace-mcp
# Then from an MCP client: manage_accounts { "operation": "authenticate" }
```
