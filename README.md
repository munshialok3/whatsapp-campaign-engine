# ⚡ WhatsApp Campaign Engine

> **Zero-downtime WhatsApp campaign infrastructure with automatic template failover.**  
> Built solo. Runs 9 business accounts. Costs ~$0/month.

[![Made with Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com)
[![Powered by Meta Graph API](https://img.shields.io/badge/Meta-Graph%20API-blue)](https://developers.facebook.com/docs/whatsapp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## The Problem

You're running a WhatsApp campaign. Meta reviews and **pauses your template with zero warning**. Mid-send. No fallback. Messages stop. Your team finds out when users complain.

Multiply that across 9 separate WhatsApp Business accounts — all managed manually — and you have a system that breaks silently at the worst possible time.

## The Solution

An intelligent **proxy layer** that sits between your CRM platform and WhatsApp messaging provider.

```
CRM Platform  →  [Proxy Worker]  →  Messaging Provider  →  Users
                       ↓
               ┌──────────────┐
               │ Meta API     │  Check template status
               │ KV Cache     │  3-min cache per account
               │ Backup Chain │  Auto-swap if paused
               │ Audit Log    │  Every decision logged
               │ Email Alert  │  Instant notifications
               └──────────────┘
```

When Meta pauses a template:
- Proxy intercepts the send request
- Checks status via Meta Graph API (cached 3 min)
- Swaps template name to next approved backup
- Provider renders the backup body automatically
- Decision logged — team alerted instantly

**Campaign continues. Users never notice.**

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   CRM Platform                       │
│         (CleverTap / any CRM with webhooks)         │
└──────────────────────┬──────────────────────────────┘
                       │ Campaign send request
                       ▼
┌─────────────────────────────────────────────────────┐
│              Proxy Worker (Cloudflare)               │
│                                                      │
│  1. Parse incoming payload                          │
│  2. Identify account (phone → WABA mapping)         │
│  3. Check template status (KV cache, 3 min TTL)     │
│  4. If APPROVED  → forward to provider              │
│  5. If PAUSED    → find next backup in chain        │
│  6. If ALL DOWN  → block + alert                    │
│  7. Log decision to Apps Script web app             │
└──────────┬────────────────────────────┬─────────────┘
           │                            │
           ▼                            ▼
┌──────────────────┐          ┌──────────────────────┐
│ Messaging        │          │ Apps Script Web App  │
│ Provider (Karix  │          │                      │
│ / any WABA)      │          │ • Audit log sheet    │
│                  │          │ • Backup chain mgmt  │
└──────────────────┘          │ • Template import    │
                              │ • Email alerts       │
                              │ • Ops dashboard UI   │
                              └──────────────────────┘
```

---

## Key Insight: Why Template Swapping Works

> Most people assume backups need identical body text. They don't.

The messaging API never sends body text. It sends only:
- **Template name**
- **Variable values** (the `{{1}}`, `{{2}}` placeholders)

The provider renders the body from its own records. So swapping the template name causes the provider to render the backup's body automatically.

**Only constraint:** Backup must use the same number of variables as the primary. Body wording, emojis, and button text can all differ freely.

---

## Features

| Feature | Description |
|---|---|
| **Auto-swap** | Detects paused templates and swaps to backup in <3 seconds |
| **Backup chains** | Up to 4 backups per campaign, independent per account |
| **KV cache** | 3-min Meta API cache — safe at high campaign volume |
| **Multi-WABA** | Supports N accounts with a single worker |
| **Full audit log** | Every FORWARDED / SWAPPED / BLOCKED decision captured |
| **Email alerts** | Instant notification on any swap or block event |
| **Ops dashboard** | Submit, manage, and monitor everything from a spreadsheet UI |
| **Template import** | Bulk import approved templates from Meta via one URL |

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Proxy | Cloudflare Workers | Edge compute, <1ms latency, free tier |
| Cache | Cloudflare KV | Fast key-value store, 3-min TTL |
| Backend | Google Apps Script | Zero infra, triggers, email built-in |
| Database | Google Sheets | Searchable audit log, easy to share |
| API | Meta Graph API | Template status, WABA management |

**Total monthly cost: ~$0** (Cloudflare free tier + Google Workspace)

---

## Setup Guide

### Prerequisites
- Cloudflare account (free)
- Google account (for Apps Script + Sheets)
- Meta Developer account with WABA access
- A messaging provider that accepts HTTP webhook sends

### Step 1 — Deploy the Apps Script Backend

1. Go to [script.google.com](https://script.google.com) → New Project
2. Copy `Code.gs` from this repo into the editor
3. Copy `Dashboard.html` → File → New → HTML file → name it `Dashboard`
4. In `Code.gs`, update the `WABA_MAP` with your account codes and WABA IDs
5. Click **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone** (or your org)
6. Copy the deployment URL — you'll need it in Step 3

### Step 2 — Set Up Google Sheet

The script auto-creates sheets on first run. To initialise manually:
1. Create a new Google Sheet
2. Copy the Sheet ID from the URL
3. Update `SHEET_ID` in `Code.gs`

Sheets created automatically:
- `Campaign Config` — backup chains per campaign
- `Proxy Log` — every send decision
- `Template Registry` — imported templates
- `Alert Log` — email alerts sent

### Step 3 — Deploy the Proxy Worker

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create KV namespace
wrangler kv namespace create "TEMPLATE_STATUS_CACHE"
# Copy the namespace ID from the output

# Clone this repo
git clone https://github.com/munshialok3/whatsapp-campaign-engine
cd whatsapp-campaign-engine

# Update wrangler.toml with your KV namespace ID
# Update proxy-worker.js with your Apps Script URL and provider endpoint
```

Update `wrangler.toml`:
```toml
name = "wa-campaign-proxy"
main = "proxy-worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "TEMPLATE_CACHE"
id = "YOUR_KV_NAMESPACE_ID"
```

```bash
# Deploy
wrangler deploy
```

### Step 4 — Deploy the Import Worker

```bash
# Same process for import-worker.js
# This worker fetches all approved UTILITY templates from Meta
```

### Step 5 — Configure Your CRM

In your CRM platform, update the campaign send endpoint:

```
BEFORE: https://your-messaging-provider.com/send
AFTER:  https://wa-campaign-proxy.your-account.workers.dev/send
```

The proxy is transparent — it accepts the same payload your provider expects and forwards it identically (with template name swapped if needed).

### Step 6 — Set Up Backup Chains

In the Ops Dashboard (your Apps Script web app URL):

1. Open the **Campaigns** tab
2. For each campaign, set:
   - Primary template name
   - Backup 1, 2, 3, 4 (in priority order)
   - Account code (maps to your WABA)
3. Click **Save Chain**

---

## Configuration

### WABA Map (in `Code.gs`)
```javascript
const WABA_MAP = {
  'ACCOUNT_CODE_1': 'WABA_ID_1',
  'ACCOUNT_CODE_2': 'WABA_ID_2',
  // Add all your accounts
}
```

### Phone → Account Map (in `proxy-worker.js`)
```javascript
const PHONE_TO_ACCOUNT = {
  '91XXXXXXXXXX': 'ACCOUNT_CODE_1',
  '91XXXXXXXXXX': 'ACCOUNT_CODE_2',
}
```

### Meta API Token
Store in Cloudflare Worker environment variables (never in code):
```bash
wrangler secret put META_ACCESS_TOKEN
```

---

## How the Proxy Decides

```
Incoming send request
        │
        ▼
Extract template name + sender phone
        │
        ▼
Map phone → account code → WABA ID
        │
        ▼
Check KV cache for template status
        │
   Cached?  ──Yes──▶  Use cached status
        │No
        ▼
Call Meta Graph API → cache result (3 min)
        │
        ▼
   APPROVED? ──Yes──▶  Forward to provider ──▶ Log FORWARDED
        │No
        ▼
   Look up backup chain for this campaign
        │
   Backup found? ──Yes──▶  Swap name ──▶ Forward ──▶ Log SWAPPED + Alert
        │No
        ▼
   Block request ──▶ Log BLOCKED ──▶ Email alert ──▶ Return error
```

---

## Dashboard

The Ops Dashboard (Google Apps Script web app) has 6 tabs:

| Tab | What it does |
|---|---|
| **Overview** | Live stats — sends today, swap rate, blocked count |
| **Proxy Log** | Every decision with timestamp, account, template, outcome |
| **Campaigns** | Manage backup chains per campaign |
| **Templates** | Browse and submit templates for Meta review |
| **Import** | Bulk import approved templates from Meta |
| **Alerts** | History of all email alerts sent |

---

## Frequently Asked Questions

**Q: Does the backup template need identical body text?**  
No. Only the variable count must match. Body, emojis, and button text can all differ.

**Q: What happens if all backups are also paused?**  
The proxy blocks the send, logs a BLOCKED decision, and sends an email alert immediately. Your team knows before users notice.

**Q: Can this handle multiple simultaneous campaigns?**  
Yes. Backup chains are keyed by primary template name + account code, so multiple campaigns run independently.

**Q: Is there a rate limit risk from checking Meta's API so often?**  
No. The 3-minute KV cache means each template is checked at most 20 times per hour per account — well within Meta's limits.

**Q: Does this work with any messaging provider?**  
Yes. The proxy forwards the exact same payload your provider expects. Just change the endpoint URL.

---

## Contributing

Pull requests welcome. If you're using this for your own campaigns, open an issue — I'd love to know what you're building.

---

## License

MIT — use it, modify it, ship it. Attribution appreciated but not required.

---

## Built by

**Alok Munshi** — Senior Growth Analyst at Eternal (Zomato). I build the infrastructure I wish existed.

- [LinkedIn](https://linkedin.com/in/munshialok) — Full technical breakdown post
- [Portfolio](https://alok-ai-lab.vercel.app) — More projects
- [GitHub](https://github.com/munshialok3)

---

*If this saved your campaign, star the repo. If it didn't work for your setup, open an issue.*
