# NanoClaw Grafana Observability Stack

Built by Victor. Lives at `groups/victor/observability/`.

Monitors all NanoClaw agents in real time: token costs, queue depth, heartbeat liveness, message throughput, and per-agent state.

---

## Architecture

```
NanoClaw host
│
├── collector daemon (Bun)
│   └── polls every 5s:
│       ├── outbound.db  — agent state, messages sent, processing acks
│       ├── inbound.db   — queue depth
│       ├── .heartbeat   — liveness mtime
│       └── v2.db        — token usage ledger
│       → writes to collector.db
│
└── Grafana (Docker)
    └── reads collector.db via frser-sqlite-datasource plugin
        → serves dashboards at http://localhost:3000
```

---

## Prerequisites

- Docker installed and running
- Bun installed (`brew install bun` or `curl -fsSL https://bun.sh/install | bash`)
- NanoClaw running (so agent session DBs exist)

---

## First-Time Setup

### Step 1 — Run the installer

From the NanoClaw root directory:

```bash
NANOCLAW_BASE=/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw \
  bash groups/victor/observability/install.sh
```

This does three things:
1. Substitutes `NANOCLAW_BASE` into the Docker Compose volume mounts
2. Builds the collector container
3. Starts both the collector and Grafana in the background

### Step 2 — Open Grafana

```
http://localhost:3000
```

Login: `admin` / `changeme`

Change your password at: `http://localhost:3000/profile/password`

> **Note:** On first start, Grafana installs the `frser-sqlite-datasource` plugin (~30 seconds). If the datasource shows an error on first load, wait and refresh.

---

## Starting and Stopping

### Start

```bash
cd groups/victor/observability
docker compose up -d
```

### Stop

```bash
cd groups/victor/observability
docker compose down
```

### Restart Grafana only

```bash
docker compose restart grafana
```

### View collector logs

```bash
docker compose logs -f collector
```

---

## Port Conflict (3000 already in use)

If port 3000 is taken (e.g. by the OneCLI credential proxy or another service), Docker will fail to bind. Either free port 3000, or edit `docker-compose.yml` to use a different host port:

```yaml
ports:
  - "3001:3000"   # change 3001 to any free port
```

Then start normally — Grafana will be at `http://localhost:3001`.

To check which port Grafana is actually running on:

```bash
docker ps | grep grafana
```

---

## Accessing the Dashboards

Once running, open your browser to the port Grafana is on (default 3000):

| Dashboard | URL |
|-----------|-----|
| NanoClaw Agents (default) | `http://localhost:3000` |
| Direct dashboard link | `http://localhost:3000/dashboards` |

The **NanoClaw Agent Observability** dashboard loads automatically. It includes:

| Panel | Description |
|-------|-------------|
| Active Agents | Agents with heartbeat < 30s |
| System Cost Today | Total token cost since midnight UTC |
| Total Queue Depth | Pending messages across all agents |
| Failed Acks Today | Failed processing_ack entries since midnight |
| Agent Status table | Per-agent: state, current tool, heartbeat age, queue depth, messages sent today |
| Daily Cost per Agent | 30-day cost trend per agent |
| Output Tokens per Agent | 30-day output token trend |
| Heartbeat Age | 6-hour liveness timeline (red line = 120s dead threshold) |

Any additional dashboards (e.g. cost/budget dashboards created via the Grafana UI) are persisted in the `grafana-storage` Docker volume and will reappear on the next start.

---

## Token Cost Pricing Model

The collector pre-computes `cost_usd` using Claude Sonnet 4.6 rates:

| Token type | Rate |
|------------|------|
| Input | $3.00 / M tokens |
| Output | $15.00 / M tokens |
| Cache write | $3.75 / M tokens |
| Cache read | $0.30 / M tokens |

Update the `PRICE` constant in `collector/collector.ts` if the model or pricing changes.

---

## File Locations

| File | Purpose |
|------|---------|
| `groups/victor/observability/docker-compose.yml` | Starts Grafana + collector containers |
| `groups/victor/observability/install.sh` | One-shot installer (first-time setup) |
| `groups/victor/observability/collector/collector.ts` | Bun daemon — polls agent DBs, writes collector.db |
| `groups/victor/observability/collector/agents.json` | Collector config (paths, NanoClaw data dir) |
| `groups/victor/observability/grafana/provisioning/datasources/sqlite.yml` | Wires collector.db as Grafana datasource |
| `groups/victor/observability/grafana/provisioning/dashboards/nanoclaw-agents.json` | Main dashboard definition |

---

## Troubleshooting

**No data in panels**
Check collector logs: `docker compose logs -f collector`. Look for `outbound.db read error` — means the NanoClaw base path is wrong in `docker-compose.yml`.

**Grafana SQLite plugin error on first load**
Wait 60 seconds for the plugin to install, then refresh. If it persists: `docker compose restart grafana`.

**collector.db locked**
Only the collector daemon should write to it; Grafana opens it read-only. Check for multiple collector processes: `ps aux | grep collector`.

**Port already in use**
See "Port Conflict" section above. The most common cause is the NanoClaw credential proxy running on port 3000 (change in `.env`: `CREDENTIAL_PROXY_PORT=3002`).
