---
name: gcp-project
description: Switch the active GCP project or check which project is currently active.
---

# gcp-project — GCP Project Switcher

Use this skill to switch your active `gcloud` project or check which project is currently set.

## Develom Projects

| Alias | Project ID            | Purpose                        |
|-------|-----------------------|--------------------------------|
| lang  | dvlm-lang-rag         | Legacy RAG / language workload |
| prod  | dvlm-develom-ai       | Primary production project     |
| dev   | dvlm-develom-ai-dev   | Development environment        |
| stg   | dvlm-develom-ai-stg   | Staging environment            |

## Usage

### Check current project

```
/gcp-project
```

Run:
```bash
gcloud config get-value project
```

### Switch project

```
/gcp-project <alias or project-id>
```

Examples:
- `/gcp-project prod` → switches to `dvlm-develom-ai`
- `/gcp-project dev`  → switches to `dvlm-develom-ai-dev`
- `/gcp-project stg`  → switches to `dvlm-develom-ai-stg`
- `/gcp-project lang` → switches to `dvlm-lang-rag`

Run:
```bash
gcloud config set project <project-id>
```

Then confirm:
```bash
gcloud config get-value project
```

## Instructions for Claude

When this skill is invoked:

1. **No argument** — run `gcloud config get-value project` and report the current active project.

2. **With an alias** — resolve it using the table above, run `gcloud config set project <project-id>`, then confirm with `gcloud config get-value project`.

3. **With a full project ID** — use it directly without resolving an alias.

Always report the project name and ID after any switch so the user can confirm.
