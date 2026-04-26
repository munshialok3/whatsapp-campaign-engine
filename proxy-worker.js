/**
 * ============================================================
 * WHATSAPP SEND PROXY WORKER  v2.0
 * Cloudflare Workers
 * ============================================================
 *
 * Flow:
 *   CRM Platform → POST here
 *       ↓
 *   1.  Parse & log raw payload (for debugging field names)
 *   2.  Extract template name — tries multiple field paths
 *   3.  Extract wabaNumber → map to Account Code
 *   4.  Get messaging provider token for that account
 *   5.  Check template status on Meta (with KV cache, 3-min TTL)
 *   6.  APPROVED → forward to messaging provider as-is
 *   7.  NOT APPROVED → look up active batch for this template
 *   8.  Walk backup chain → first APPROVED backup → swap name only
 *       (Meta renders backup body/button from its own records)
 *   9.  No backups → BLOCK
 *   10. Log every decision to Apps Script (?ct=3)
 *   11. Alert on SWAP or BLOCK (?ct=4)
 *
 * Key design decisions:
 *   - Template name swap ONLY — Meta renders backup body automatically
 *   - Param count parity is the only structural constraint
 *   - KV cache for Meta status checks (3-min TTL) to avoid rate limits
 *   - Multiple active batches per Account Code supported
 *   - Raw payload logged to sheet on first call for field inspection
 *
 * Cloudflare Secrets (Workers → Settings → Variables):
 *   SHARED_SECRET              — shared secret token
 *   META_TOKEN                 — Meta Graph API token
 *   APPS_SCRIPT_URL            — Apps Script web app URL
 *   PROVIDER_ENDPOINT          — Your messaging provider API endpoint
 *   PROVIDER_TOKEN_ACCOUNT_1   — Bearer token for account 1
 *   PROVIDER_TOKEN_ACCOUNT_2   — Bearer token for account 2
 *   (add one secret per account following the same pattern)
 *
 * KV Namespace binding (Workers → KV → bind as TPL_STATUS_CACHE):
 *   TPL_STATUS_CACHE           — KV namespace for template status cache
 *
 * ============================================================
 */

// ── Phone number → Account Code ──────────────────────────────
// Replace with your actual WhatsApp Business phone numbers.
// Format: "FULL_NUMBER_WITH_COUNTRY_CODE": "YOUR_ACCOUNT_CODE"
const WABA_NUMBER_MAP = {
  "91XXXXXXXXXX": "ACCOUNT_1",
  "91XXXXXXXXXX": "ACCOUNT_2",
  // Add all your accounts here
};

// ── Account Code → WABA ID ───────────────────────────────────
// Get WABA IDs from Meta Business Manager → WhatsApp Accounts
const WABA_ID_MAP = {
  "ACCOUNT_1": "YOUR_WABA_ID_1",
  "ACCOUNT_2": "YOUR_WABA_ID_2",
  // Add all your accounts here
};

const GRAPH_VERSION  = "v18.0";
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 1500;
const KV_TTL_SECONDS = 180;
const KV_DEBUG_KEY   = "debug_payload_captured";

export default {
  async fetch(request, env) {

    if (request.method !== "POST") {
      return resp({ error: "Only POST is supported." }, 405);
    }

    let rawBody = "";
    let payload;
    try {
      rawBody = await request.text();
      payload = JSON.parse(rawBody);
    } catch (e) {
      return resp({ error: "Invalid JSON payload." }, 400);
    }

    // Capture first payload to sheet for field name inspection
    await captureDebugPayloadOnce(env, rawBody);

    // Try multiple field paths — CRM payload structures vary
    const templateNameRaw = (
      payload?.template?.name       ||
      payload?.template?.namespace  ||
      payload?.templateName         ||
      payload?.template_name        ||
      payload?.msgTemplate          ||
      ""
    ).toString().toLowerCase().trim();

    if (!templateNameRaw) {
      fireLog(env, {
        acCode: "UNKNOWN", to: "", originalTpl: "", usedTpl: "",
        action: "BLOCKED",
        reason: `Could not find template name. Keys: ${Object.keys(payload || {}).join(", ")}`,
        msgId: ""
      });
      return resp({ error: "Could not determine template name from payload." }, 400);
    }

    const wabaNumber = (payload?.wabaNumber || payload?.waba_number || payload?.from || "")
      .toString().replace(/[\s\-\+]/g, "");
    const toNumber = (payload?.to || payload?.dest || "").toString();
    const msgId    = (payload?.msgId || payload?.msg_id || payload?.messageId || "").toString();

    if (!wabaNumber) {
      return resp({ error: "Could not find wabaNumber in payload." }, 400);
    }

    const acCode = WABA_NUMBER_MAP[wabaNumber];
    if (!acCode) {
      return resp({ error: `wabaNumber "${wabaNumber}" not mapped to any Account Code.` }, 400);
    }

    // Store provider tokens as Cloudflare secrets: PROVIDER_TOKEN_{ACCOUNT_CODE}
    const providerToken = env[`PROVIDER_TOKEN_${acCode}`];
    if (!providerToken) {
      return resp({ error: `PROVIDER_TOKEN_${acCode} not set in Cloudflare secrets.` }, 500);
    }

    const wabaId = WABA_ID_MAP[acCode];
    if (!wabaId) {
      return resp({ error: `No WABA ID configured for ${acCode}.` }, 500);
    }

    const primaryStatus = await checkTemplateStatus(templateNameRaw, wabaId, env);

    if (primaryStatus === "APPROVED") {
      const providerResp = await forwardToProvider(payload, providerToken, env.PROVIDER_ENDPOINT);
      fireLog(env, {
        acCode, to: toNumber, originalTpl: templateNameRaw,
        usedTpl: templateNameRaw, action: "FORWARDED",
        reason: "Template approved", msgId
      });
      return new Response(providerResp.body, {
        status:  providerResp.status,
        headers: { "Content-Type": "application/json" }
      });
    }

    console.log(`"${templateNameRaw}" status: ${primaryStatus}. Checking batches for ${acCode}.`);

    const batchData = await fetchBatchForTemplate(templateNameRaw, acCode, env);

    if (!batchData || !batchData.ok) {
      const reason = `Template "${templateNameRaw}" is ${primaryStatus}. No active batch found on ${acCode}.`;
      fireLog(env,  { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: "", action: "BLOCKED", reason, msgId });
      fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: "", to: toNumber, action: "BLOCKED", reason, msgId });
      return resp({ error: `BLOCKED: ${reason}` }, 503);
    }

    // Walk backup chain — only template name is swapped.
    // Provider renders the backup body/buttons from its own records.
    // Only constraint: backup must have the same number of {{N}} params.
    const backupChain = [
      batchData.backup1, batchData.backup2,
      batchData.backup3, batchData.backup4
    ].filter(n => n && n.trim());

    for (const backupName of backupChain) {
      const backupStatus = await checkTemplateStatus(backupName, wabaId, env);

      if (backupStatus === "APPROVED") {
        const swappedPayload = swapTemplateName(payload, backupName);
        const providerResp   = await forwardToProvider(swappedPayload, providerToken, env.PROVIDER_ENDPOINT);

        const reason = `"${templateNameRaw}" is ${primaryStatus}. Auto-switched to backup "${backupName}".`;
        fireLog(env,  { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: backupName, action: "SWAPPED", reason, msgId });
        fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: backupName, to: toNumber, action: "SWAPPED", reason, msgId });

        return new Response(providerResp.body, {
          status:  providerResp.status,
          headers: { "Content-Type": "application/json" }
        });
      }
      console.log(`Backup "${backupName}" also not approved (${backupStatus}). Trying next.`);
    }

    const reason = `"${templateNameRaw}" is ${primaryStatus}. All ${backupChain.length} backup(s) also unavailable.`;
    fireLog(env,  { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: "", action: "BLOCKED", reason, msgId });
    fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: "", to: toNumber, action: "BLOCKED", reason, msgId });

    return resp({ error: `BLOCKED: ${reason}` }, 503);
  }
};


async function checkTemplateStatus(templateName, wabaId, env) {
  const cacheKey = `tpl:${wabaId}:${templateName}`;

  if (env.TPL_STATUS_CACHE) {
    try {
      const cached = await env.TPL_STATUS_CACHE.get(cacheKey);
      if (cached) return cached;
    } catch (e) { console.error("KV read error:", e.message); }
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
              `?fields=name,status&name=${encodeURIComponent(templateName)}&limit=10`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const metaResp = await fetch(url, {
        headers: { "Authorization": `Bearer ${env.META_TOKEN}` }
      });
      const data = await metaResp.json();

      if (!metaResp.ok || !data.data) {
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
        continue;
      }

      const match  = data.data.find(t => t.name.toLowerCase() === templateName.toLowerCase());
      const status = match ? match.status : "NOT_FOUND";

      if (env.TPL_STATUS_CACHE) {
        try {
          await env.TPL_STATUS_CACHE.put(cacheKey, status, { expirationTtl: KV_TTL_SECONDS });
        } catch (e) { console.error("KV write error:", e.message); }
      }
      return status;

    } catch (err) {
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  return "UNREACHABLE";
}


async function fetchBatchForTemplate(templateName, acCode, env) {
  if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) return null;
  try {
    const url = `${env.APPS_SCRIPT_URL}?ct=5` +
                `&ac=${encodeURIComponent(acCode)}` +
                `&primary=${encodeURIComponent(templateName)}` +
                `&token=${encodeURIComponent(env.SHARED_SECRET)}`;
    const r = await fetch(url, { method: "GET" });
    return await r.json();
  } catch (e) {
    console.error("Batch fetch failed:", e.message);
    return null;
  }
}


async function forwardToProvider(payload, providerToken, providerEndpoint) {
  // Update this endpoint and headers to match your messaging provider
  const endpoint = providerEndpoint || "https://your-messaging-provider.com/api/send";
  const r = await fetch(endpoint, {
    method:  "POST",
    headers: {
      "Authorization": providerToken.startsWith("Bearer ") ? providerToken : `Bearer ${providerToken}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(payload)
  });
  return { status: r.status, body: await r.text() };
}


function swapTemplateName(payload, newName) {
  const s = JSON.parse(JSON.stringify(payload));
  if (s?.template?.name !== undefined)      s.template.name = newName;
  if (s?.template?.namespace !== undefined) s.template.namespace = newName;
  if (s?.templateName !== undefined)        s.templateName = newName;
  if (s?.template_name !== undefined)       s.template_name = newName;
  if (s?.msgTemplate !== undefined)         s.msgTemplate = newName;
  return s;
}


async function captureDebugPayloadOnce(env, rawBody) {
  if (!env.TPL_STATUS_CACHE || !env.APPS_SCRIPT_URL || !env.SHARED_SECRET) return;
  try {
    const already = await env.TPL_STATUS_CACHE.get(KV_DEBUG_KEY);
    if (already) return;
    await env.TPL_STATUS_CACHE.put(KV_DEBUG_KEY, "1", { expirationTtl: 86400 * 30 });
    const params = new URLSearchParams({ ct: "98", token: env.SHARED_SECRET, payload: rawBody.substring(0, 3000) });
    fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
  } catch (e) { /* non-critical */ }
}


function fireLog(env, data) {
  if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) return;
  const params = new URLSearchParams({
    ct: "3", token: env.SHARED_SECRET,
    acCode: data.acCode || "", to: data.to || "",
    originalTpl: data.originalTpl || "", usedTpl: data.usedTpl || "",
    action: data.action || "", reason: data.reason || "", msgId: data.msgId || ""
  });
  fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
}


function fireAlert(env, data) {
  if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) return;
  const params = new URLSearchParams({
    ct: "4", token: env.SHARED_SECRET,
    acCode: data.acCode || "", originalTpl: data.originalTpl || "",
    usedTpl: data.usedTpl || "", to: data.to || "",
    action: data.action || "", reason: data.reason || "", msgId: data.msgId || ""
  });
  fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
}


function resp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
