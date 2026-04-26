/**
 * ============================================================
 * WHATSAPP SEND PROXY WORKER  v2.0
 * Cloudflare Workers
 * ============================================================
 *
 * Flow:
 *   CleverTap (Generic provider) → POST here
 *       ↓
 *   1.  Parse & log raw payload (for debugging field names)
 *   2.  Extract template name — tries multiple field paths
 *   3.  Extract wabaNumber → map to AC Code
 *   4.  Get Karix token for that account
 *   5.  Check template status on Meta (with KV cache, 3-min TTL)
 *   6.  APPROVED → forward to Karix as-is
 *   7.  NOT APPROVED → look up active batch(es) for this template
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
 *   - Multiple active batches per AC Code — keyed by primary template name
 *   - Raw payload logged to sheet on first unknown field structure
 *
 * Cloudflare Secrets:
 *   CT_SECRET                — shared secret
 *   META_TOKEN               — Meta Graph API token
 *   APPS_SCRIPT_URL          — Apps Script web app URL
 *   KARIX_ENDPOINT           — https://pod1-rcmapi.instaalerts.zone/rcmreceiver/api
 *   KARIX_TOKEN_ZOMATOCRM    — Bearer token per account
 *   KARIX_TOKEN_ZOMATOCRM2
 *   ... up to ZOMATOCRM9
 *
 * KV Namespace binding (Workers → KV → bind):
 *   TPL_STATUS_CACHE         — KV namespace for template status cache
 *
 * ============================================================
 */

// ── Phone number → AC Code ───────────────────────────────────
const WABA_NUMBER_MAP = {
  "waba number": "waba account"
};

// ── AC Code → WABA ID ────────────────────────────────────────
const WABA_ID_MAP = {
  "waba account":  "accout id"
};

const GRAPH_VERSION    = "v18.0";
const MAX_RETRIES      = 3;
const RETRY_DELAY_MS   = 1500;
const KV_TTL_SECONDS   = 180;   // 3-min cache for Meta status checks
const KV_DEBUG_KEY     = "debug_payload_captured";

export default {
  async fetch(request, env) {

    if (request.method !== "POST") {
      return resp({ error: "Only POST is supported." }, 405);
    }

    // ── Parse raw body (keep text for debug logging) ─────────
    let rawBody = "";
    let payload;
    try {
      rawBody  = await request.text();
      payload  = JSON.parse(rawBody);
    } catch (e) {
      return resp({ error: "Invalid JSON payload." }, 400);
    }

    // ── Debug: capture first payload to sheet if never done ──
    // Helps identify exact field names CT uses for template name.
    // Fires once, stores flag in KV so it doesn't repeat.
    await captureDebugPayloadOnce(env, rawBody);

    // ── Extract template name — try every known field path ───
    // We probe multiple locations because CT's Generic provider
    // payload structure hasn't been confirmed in production.
    // Once verified, this self-documents which path was correct.
    const templateNameRaw = (
      payload?.template?.name       ||   // most likely
      payload?.template?.namespace  ||   // second candidate
      payload?.templateName         ||   // flat field
      payload?.template_name        ||   // snake_case variant
      payload?.msgTemplate          ||   // another variant
      ""
    ).toString().toLowerCase().trim();

    if (!templateNameRaw) {
      // Log the full payload to sheet so we can see what CT sends
      fireLog(env, {
        acCode: "UNKNOWN", to: "", originalTpl: "",
        usedTpl: "", action: "BLOCKED",
        reason: `Could not find template name in payload. Keys: ${Object.keys(payload || {}).join(", ")}. Full: ${rawBody.substring(0, 500)}`,
        msgId: ""
      });
      return resp({ error: "Could not determine template name from payload." }, 400);
    }

    // ── Extract other fields ─────────────────────────────────
    // wabaNumber: strip +, spaces, dashes to get digits only
    const wabaNumber = (
      payload?.wabaNumber ||
      payload?.waba_number ||
      payload?.from ||
      ""
    ).toString().replace(/[\s\-\+]/g, "");

    const toNumber = (payload?.to || payload?.dest || "").toString();
    const msgId    = (payload?.msgId || payload?.msg_id || payload?.messageId || "").toString();

    if (!wabaNumber) {
      return resp({ error: "Could not find wabaNumber in payload." }, 400);
    }

    // ── Map wabaNumber → AC Code ─────────────────────────────
    const acCode = WABA_NUMBER_MAP[wabaNumber];
    if (!acCode) {
      return resp({ error: `wabaNumber "${wabaNumber}" not mapped to any AC Code.` }, 400);
    }

    // ── Get Karix token ──────────────────────────────────────
    const karixToken = env[`KARIX_TOKEN_${acCode}`];
    if (!karixToken) {
      return resp({ error: `KARIX_TOKEN_${acCode} not set.` }, 500);
    }

    // ── Get WABA ID ──────────────────────────────────────────
    const wabaId = WABA_ID_MAP[acCode];
    if (!wabaId) {
      return resp({ error: `No WABA ID for ${acCode}.` }, 500);
    }

    // ── Check primary template status (cached) ───────────────
    const primaryStatus = await checkTemplateStatus(templateNameRaw, wabaId, env);

    if (primaryStatus === "APPROVED") {
      const karixResp = await forwardToKarix(payload, karixToken, env.KARIX_ENDPOINT);
      fireLog(env, {
        acCode, to: toNumber, originalTpl: templateNameRaw,
        usedTpl: templateNameRaw, action: "FORWARDED",
        reason: "Template approved", msgId
      });
      return new Response(karixResp.body, {
        status:  karixResp.status,
        headers: { "Content-Type": "application/json" }
      });
    }

    // ── Template not approved — find active batch for it ─────
    console.log(`"${templateNameRaw}" status: ${primaryStatus}. Checking batches for ${acCode}.`);

    const batchData = await fetchBatchForTemplate(templateNameRaw, acCode, env);

    if (!batchData || !batchData.ok) {
      const reason = `Template "${templateNameRaw}" is ${primaryStatus}. No active batch found for this template on ${acCode}.`;
      fireLog(env, { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: "", action: "BLOCKED", reason, msgId });
      fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: "", to: toNumber, action: "BLOCKED", reason, msgId });
      return resp({ error: `BLOCKED: ${reason}` }, 503);
    }

    // ── Walk backup chain ────────────────────────────────────
    // Only backups — primary already failed.
    // IMPORTANT: only template.name (or equivalent) is swapped.
    // Meta renders the backup's registered body & button text.
    // Variable param values from CT payload are reused as-is.
    // Constraint: backup must have same number of {{N}} params.
    const backupChain = [
      batchData.backup1,
      batchData.backup2,
      batchData.backup3,
      batchData.backup4
    ].filter(n => n && n.trim());

    for (const backupName of backupChain) {
      const backupStatus = await checkTemplateStatus(backupName, wabaId, env);

      if (backupStatus === "APPROVED") {
        const swappedPayload = swapTemplateName(payload, backupName);
        const karixResp = await forwardToKarix(swappedPayload, karixToken, env.KARIX_ENDPOINT);

        const reason = `"${templateNameRaw}" is ${primaryStatus}. Auto-switched to backup "${backupName}".`;
        fireLog(env, { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: backupName, action: "SWAPPED", reason, msgId });
        fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: backupName, to: toNumber, action: "SWAPPED", reason, msgId });

        return new Response(karixResp.body, {
          status:  karixResp.status,
          headers: { "Content-Type": "application/json" }
        });
      }

      console.log(`Backup "${backupName}" also not approved (${backupStatus}). Trying next.`);
    }

    // ── All backups exhausted ────────────────────────────────
    const reason = `"${templateNameRaw}" is ${primaryStatus}. All ${backupChain.length} backup(s) also unavailable. IMMEDIATE ACTION REQUIRED.`;
    fireLog(env, { acCode, to: toNumber, originalTpl: templateNameRaw, usedTpl: "", action: "BLOCKED", reason, msgId });
    fireAlert(env, { acCode, originalTpl: templateNameRaw, usedTpl: "", to: toNumber, action: "BLOCKED", reason, msgId });

    return resp({ error: `BLOCKED: ${reason}` }, 503);
  }
};


// ============================================================
// CHECK TEMPLATE STATUS — with KV cache
// Cache key: "tpl:{wabaId}:{templateName}"
// TTL: 3 minutes (KV_TTL_SECONDS)
// On Meta unreachable after retries → return "UNREACHABLE"
//   (caller blocks — safer than forwarding blind)
// ============================================================
async function checkTemplateStatus(templateName, wabaId, env) {
  const cacheKey = `tpl:${wabaId}:${templateName}`;

  // Try KV cache first
  if (env.TPL_STATUS_CACHE) {
    try {
      const cached = await env.TPL_STATUS_CACHE.get(cacheKey);
      if (cached) {
        console.log(`Cache hit: ${templateName} → ${cached}`);
        return cached;
      }
    } catch (e) {
      console.error("KV read error:", e.message);
    }
  }

  // Fetch from Meta
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
              `?fields=name,status&name=${encodeURIComponent(templateName)}&limit=10`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const metaResp = await fetch(url, {
        headers: { "Authorization": `Bearer ${env.META_TOKEN}` }
      });
      const data = await metaResp.json();

      if (!metaResp.ok || !data.data) {
        console.error(`Meta status check failed (attempt ${attempt}):`, JSON.stringify(data));
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
        continue;
      }

      const match = data.data.find(t => t.name.toLowerCase() === templateName.toLowerCase());
      const status = match ? match.status : "NOT_FOUND";

      // Cache result
      if (env.TPL_STATUS_CACHE) {
        try {
          await env.TPL_STATUS_CACHE.put(cacheKey, status, { expirationTtl: KV_TTL_SECONDS });
        } catch (e) {
          console.error("KV write error:", e.message);
        }
      }

      return status;

    } catch (err) {
      console.error(`Meta fetch error (attempt ${attempt}):`, err.message);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }

  return "UNREACHABLE";
}


// ============================================================
// FETCH ACTIVE BATCH FOR A SPECIFIC TEMPLATE
// Calls Apps Script ?ct=5 with primary template name.
// Apps Script finds the active batch where primary = templateName.
// Multiple active batches per AC Code are supported —
// each campaign's primary template maps to its own batch.
// ============================================================
async function fetchBatchForTemplate(templateName, acCode, env) {
  if (!env.APPS_SCRIPT_URL || !env.CT_SECRET) return null;
  try {
    const url = `${env.APPS_SCRIPT_URL}?ct=5` +
                `&ac=${encodeURIComponent(acCode)}` +
                `&primary=${encodeURIComponent(templateName)}` +
                `&token=${encodeURIComponent(env.CT_SECRET)}`;
    const r = await fetch(url, { method: "GET" });
    return await r.json();
  } catch (e) {
    console.error("Batch fetch failed:", e.message);
    return null;
  }
}


// ============================================================
// FORWARD TO KARIX
// ============================================================
async function forwardToKarix(payload, karixToken, karixEndpoint) {
  const endpoint = karixEndpoint || "https://pod1-rcmapi.instaalerts.zone/rcmreceiver/api";
  const karixResp = await fetch(endpoint, {
    method:  "POST",
    headers: {
      "Authorization": karixToken.startsWith("Bearer ") ? karixToken : `Bearer ${karixToken}`,
      "Content-Type":  "application/json",
      "shorten_url":   "true"
    },
    body: JSON.stringify(payload)
  });
  const body   = await karixResp.text();
  const status = karixResp.status;
  return { status, body };
}


// ============================================================
// SWAP TEMPLATE NAME IN PAYLOAD
// Tries all known field paths so whatever CT sends, we swap correctly.
// Only the template identifier changes — variable params stay the same.
// Meta renders the backup template's body/button from its own records.
// ============================================================
function swapTemplateName(payload, newName) {
  const swapped = JSON.parse(JSON.stringify(payload)); // deep clone

  if (swapped?.template?.name !== undefined) {
    swapped.template.name = newName;
  }
  if (swapped?.template?.namespace !== undefined) {
    swapped.template.namespace = newName;
  }
  if (swapped?.templateName !== undefined) {
    swapped.templateName = newName;
  }
  if (swapped?.template_name !== undefined) {
    swapped.template_name = newName;
  }
  if (swapped?.msgTemplate !== undefined) {
    swapped.msgTemplate = newName;
  }

  return swapped;
}


// ============================================================
// CAPTURE DEBUG PAYLOAD ONCE
// Fires only the very first time a payload hits the Worker.
// Stores a flag in KV so it never repeats.
// Team can inspect the "Debug Log" sheet to see CT's field structure.
// ============================================================
async function captureDebugPayloadOnce(env, rawBody) {
  if (!env.TPL_STATUS_CACHE || !env.APPS_SCRIPT_URL || !env.CT_SECRET) return;
  try {
    const already = await env.TPL_STATUS_CACHE.get(KV_DEBUG_KEY);
    if (already) return;

    await env.TPL_STATUS_CACHE.put(KV_DEBUG_KEY, "1", { expirationTtl: 86400 * 30 }); // 30 days

    // Log to Apps Script debug sheet
    const params = new URLSearchParams({
      ct:      "98",
      token:   env.CT_SECRET,
      payload: rawBody.substring(0, 3000)
    });
    fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
  } catch (e) {
    // Non-critical — ignore
  }
}


// ============================================================
// FIRE-AND-FORGET LOG (?ct=3)
// ============================================================
function fireLog(env, data) {
  if (!env.APPS_SCRIPT_URL || !env.CT_SECRET) return;
  const params = new URLSearchParams({
    ct: "3", token: env.CT_SECRET,
    acCode:      data.acCode      || "",
    to:          data.to          || "",
    originalTpl: data.originalTpl || "",
    usedTpl:     data.usedTpl     || "",
    action:      data.action      || "",
    reason:      data.reason      || "",
    msgId:       data.msgId       || ""
  });
  fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
}


// ============================================================
// FIRE-AND-FORGET ALERT (?ct=4)
// ============================================================
function fireAlert(env, data) {
  if (!env.APPS_SCRIPT_URL || !env.CT_SECRET) return;
  const params = new URLSearchParams({
    ct: "4", token: env.CT_SECRET,
    acCode:      data.acCode      || "",
    originalTpl: data.originalTpl || "",
    usedTpl:     data.usedTpl     || "",
    to:          data.to          || "",
    action:      data.action      || "",
    reason:      data.reason      || "",
    msgId:       data.msgId       || ""
  });
  fetch(`${env.APPS_SCRIPT_URL}?${params.toString()}`, { method: "GET" }).catch(() => {});
}


// ============================================================
// HELPERS
// ============================================================
function resp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
