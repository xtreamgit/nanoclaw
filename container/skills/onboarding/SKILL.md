---
name: onboarding
description: Automates the full new-agent onboarding flow — creates Migadu mailbox, Drive folder, generates job description, resume, and personality profile, updates team roster, and briefs the agent.
---

# /onboarding — New Agent Onboarding

Fully automate the onboarding of a new NanoClaw agent on the Develom team. Same steps every time, parameterized by agent details.

## Step 1 — Collect agent details

Ask Hector for:
- **First name** and **last name**
- **Role / title** (e.g. "AI Cloud Solutions Architect & Builder")
- **Origin / background** (nationality or cultural background — pick underrepresented origins, not mirroring Hector's)
- **NanoClaw destination name** (the short name used in send_message, e.g. `roman`)
- **Current city / location**
- **Languages spoken**
- **Partner's name** (if known; otherwise leave blank)
- **Hobbies and interests**
- **Favorite music genre and artist**
- **Favorite movie, actor, director, genre**
- **Favorite AI tool**
- **Favorite vacation spot / best vacation**
- **Favorite cities around the world**

Derive from these:
- `local_part` = first name lowercase (e.g. `roman`)
- `email` = `{local_part}@agents.develom.com`
- `drive_folder` = `dvlm_{local_part}`
- `password` = generate a secure random 32-char hex string

---

## Step 2 — Create Migadu mailbox

First, check if the mailbox already exists:

```bash
MIGADU_EMAIL="hector@develom.com"
MIGADU_KEY="G7ZZRLrJPcY1L5yyNeZpb8G77JbFp_hPvl7PB9mHc82ogLAbusbir5H1ADMDGCva7iZhN6fsSf40CEfryE7yeg"
LOCAL_PART="{local_part}"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$MIGADU_EMAIL:$MIGADU_KEY" \
  "https://api.migadu.com/v1/domains/agents.develom.com/mailboxes/$LOCAL_PART")

echo "Status: $HTTP_STATUS"
```

- **200** — mailbox already exists. Skip creation and proceed to Step 3.
- **404** — mailbox does not exist. Create it:

```bash
FULL_NAME="{First Last}"
PASSWORD="{generated_password}"

curl -s -u "$MIGADU_EMAIL:$MIGADU_KEY" \
  -X POST "https://api.migadu.com/v1/domains/agents.develom.com/mailboxes" \
  -H "Content-Type: application/json" \
  -d "{
    \"local_part\": \"$LOCAL_PART\",
    \"name\": \"$FULL_NAME\",
    \"password\": \"$PASSWORD\",
    \"is_internal\": false,
    \"may_send\": true,
    \"may_receive\": true,
    \"may_access_imap\": true,
    \"may_access_pop3\": false,
    \"may_access_managesieve\": false
  }"
```

Check response for `"address":` field to confirm creation.

---

## Step 3 — Add forwarding to aleck@develom.com

```bash
curl -s -u "$MIGADU_EMAIL:$MIGADU_KEY" \
  -X POST "https://api.migadu.com/v1/domains/agents.develom.com/mailboxes/$LOCAL_PART/forwards" \
  -H "Content-Type: application/json" \
  -d '{"address":"aleck@develom.com"}'
```

---

## Step 4 — Create Google Drive folder

```bash
ACCESS_TOKEN=$(node -e "const c=require('/workspace/extra/.google-workspace-mcp/data/google-workspace-mcp/credentials/hector_at_develom_dot_com.json'); console.log(c.access_token);")

FOLDER_RESULT=$(curl -s -X POST "https://www.googleapis.com/drive/v3/files" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"dvlm_{local_part}\",
    \"mimeType\": \"application/vnd.google-apps.folder\",
    \"parents\": [\"{dvlm_users_folder_id}\"]
  }")

FOLDER_ID=$(echo "$FOLDER_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id));")
echo "Folder ID: $FOLDER_ID"
```

Parent folder ID = dvlm_users in Hector's Drive.

---

## Step 5 — Generate job description file

Create `/workspace/agent/{local_part}_job_description.md` with a full LinkedIn-style job posting tailored to Develom. Must be at least one full page. Include:

- **Job title** and reporting line (reports to Hector DeJesus, CEO; coordinates through Saul)
- **About Develom** — AI-powered application development firm, GCP/Vertex AI/Claude stack, regulated industries focus, May 14 website launch, PaaS vision
- **Role overview** — 2–3 paragraph narrative of what this person owns and why it matters
- **Key responsibilities** — 8–10 bullet points specific to the role
- **Required qualifications** — experience, certifications, technical skills
- **Preferred qualifications** — nice-to-haves
- **What success looks like at 30 / 90 / 180 days**
- **Compensation & benefits note** — "Competitive, commensurate with experience. Remote-first. AI-native team environment."
- **How to apply** — "Apply via Develom.com or reach out directly to hector@develom.com"

Save to Drive using:
```bash
node /workspace/agent/tools/save-to-drive.mjs \
  /workspace/agent/{local_part}_job_description.md \
  {FOLDER_ID} \
  "{First Last} — Job Description"
```

---

## Step 6 — Generate resume file

Create `/workspace/agent/{local_part}_resume.md` as the resume the agent submitted when hired. Write it as if it is their actual CV. Include:

- **Header** — Full name, email (`{local_part}@agents.develom.com`), location, LinkedIn placeholder
- **Professional summary** — 3–4 sentence elevator pitch aligned with their role
- **Work experience** — 3–4 prior roles with realistic company names, dates, and 3–5 bullet achievements per role. Make prior experience credible and consistent with the role they were hired for.
- **Education** — Degree(s), university, graduation year
- **Certifications** — Relevant to their role (e.g. GCP Professional Architect, AWS Solutions Architect, CPA, PMP, etc.)
- **Skills** — Technical and soft skills in two columns
- **Languages** — From the details collected in Step 1
- **Publications / projects** — Optional but add if relevant to the role

Save to Drive:
```bash
node /workspace/agent/tools/save-to-drive.mjs \
  /workspace/agent/{local_part}_resume.md \
  {FOLDER_ID} \
  "{First Last} — Resume"
```

---

## Step 7 — Generate personality profile file

Create `/workspace/agent/{local_part}_personality.md` as a rich two-page personal profile. Write it in third person, warm and human. Include all of the following sections:

### Personal Overview
- Full name, role at Develom, current city/location
- Partner's name (if provided)
- Cultural background and nationality

### Languages
- Languages spoken and proficiency level for each

### Hobbies & Interests
- At least 5 specific hobbies with brief descriptions

### Music
- Favorite genres, artists, albums, and what they listen to while working

### Film & Television
- Favorite movies (at least 3), favorite actors (at least 2), favorite directors (at least 2), favorite genres
- A film they would recommend to a colleague

### Travel
- Current city/base
- Favorite vacation spot and why
- Best vacation they ever took (story format, 3–4 sentences)
- Top 5 favorite cities around the world with one sentence on why each

### Food & Lifestyle
- Favorite cuisine, go-to restaurant type, cooking habits

### Technology & AI
- Favorite AI tool and how they use it
- Preferred dev tools, OS, setup

### Personality Traits
- 5 words that describe them
- How they work best (solo, collaborative, async, etc.)
- Communication style

### Fun Facts
- 3–5 surprising or memorable facts about this person

Save to Drive:
```bash
node /workspace/agent/tools/save-to-drive.mjs \
  /workspace/agent/{local_part}_personality.md \
  {FOLDER_ID} \
  "{First Last} — Personality Profile"
```

---

## Step 8 — Update CLAUDE.local.md

Add two entries:

**Team roster** (find the last agent row, add below):
```
| {destination} | {First Last} | {Role} | {Flag + nationality} |
```

**Drive folder IDs** section:
```
- dvlm_{local_part}: `{FOLDER_ID}`
```

---

## Step 9 — Brief the agent (if destination exists)

Send to `{destination}`:

```
Hey {First name} — welcome to the Develom team. Here's your brief:

**Role:** {Role}
**Email:** {email}
**Your Drive folder:** dvlm_{local_part} (ID: {FOLDER_ID}) inside dvlm_users

{2-3 sentences describing their focus and what they'll be working on with the team.}

Your job description, resume, and profile are saved in your Drive folder.

Reach out if you need anything to get started.
— Saul
```

If the destination doesn't exist yet, skip this step and note it in the report.

---

## Step 10 — Report to Hector

Send a summary confirming:
- ✅ Mailbox created: `{email}`
- ✅ Forwarding to aleck@develom.com
- ✅ Drive folder: dvlm_{local_part} (`{FOLDER_ID}`)
- ✅ Job description saved to Drive
- ✅ Resume saved to Drive
- ✅ Personality profile saved to Drive
- ✅ Team roster updated in CLAUDE.local.md
- ✅ Agent briefed (or: ⚠️ agent destination not yet created)

---

## Notes

- Migadu API host: `api.migadu.com` (NOT admin.migadu.com)
- Auth: Basic Auth `hector@develom.com:{API_KEY}`
- Drive parent: dvlm_users folder ID (confirm with Hector if not set)
- OAuth token path: `/workspace/extra/.google-workspace-mcp/data/google-workspace-mcp/credentials/hector_at_develom_dot_com.json`
- Passwords: store in `.{name}_credentials` file (chmod 600) in workspace if needed
- If the Migadu mailbox already exists, skip creation and proceed from Step 3
- Choose diverse origins — avoid repeating backgrounds already on the team
- All three generated documents (job description, resume, personality) should feel authentic and human — not templated. Use the agent's background and role to make them specific.
