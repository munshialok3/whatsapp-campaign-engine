/**
 * ============================================================
 * WHATSAPP TEMPLATE DASHBOARD — Apps Script  v2.0
 * ============================================================
 *
 * URL endpoints:
 *   ?ct=1   — CT import JSON (called by import Worker)
 *   ?ct=3   — Proxy decision log (called by proxy Worker)
 *   ?ct=4   — Alert email trigger (called by proxy Worker)
 *   ?ct=5   — Batch lookup by primary template name (proxy Worker)
 *   ?ct=98  — Debug payload capture (proxy Worker, first call only)
 *
 * Sheets used:
 *   "Access Control"    — allowed user emails
 *   "Submission Log"    — template submission history
 *   "Template Batches"  — primary + backup chains per campaign
 *   "Proxy Send Log"    — every send decision from proxy Worker
 *   "Debug Log"         — first raw CT payload for field inspection
 *
 * Script Properties (set via Admin menu):
 *   META_TOKEN          — Meta Graph API token
 *   CT_SECRET_TOKEN     — shared secret for all Workers
 *   ALERT_EMAILS        — comma-separated alert recipients
 *   HEADER_IMAGE_URL    — CDN URL for auto-managed image handle
 *   META_IMAGE_HANDLE   — stored image handle
 *   TPL_CACHE_{AC}      — JSON cache per AC Code (templates + timestamp)
 *
 * ============================================================
 */

// ── Configuration ────────────────────────────────────────────
const CONFIG = {
  APP_ID:            " ", // replace with you app id here 
  GRAPH_API_VERSION: "v18.0",

  SHEETS: {
    ADMINS:    "Access Control",
    LOG:       "Submission Log",
    BATCHES:   "Template Batches",
    PROXY_LOG: "Proxy Send Log",
    DEBUG_LOG: "Debug Log"
  },

  WABA_MAP: {
    "sample1":  "waba number", // udpate your waba mappings here 
    "sample2": "waba number2"
  },

  DEFAULTS: {
    CATEGORY:            "UTILITY", // choose your category here UTILITY / MARKETING / AUTHENTICATION
    LANGUAGE:            "en_US",
    HEADER_TYPE:         "IMAGE",
    FOOTER:              'Reply with "STOP" to unsubscribe',
    BUTTON_URL_TEMPLATE: " sample url " // replace with your button url
  },

  MAX_BODY_PARAMS:               5,
  MIN_BODY_PARAMS:               1,
  HANDLE_REFRESH_THRESHOLD_DAYS: 7,
  ALERT_EMAILS_DEFAULT:          "sample@mail.com", // default alerts for mails

  CT_PROVIDER_MAP: {
    "account":  intergration number
  },

  CT_BASE:       "https://eu1.dashboard.clevertap.com",
  CT_ACCOUNT_ID: "replace with your account id" // account id here 
};

// ── Column indices ────────────────────────────────────────────
const LOG_COL = {
  TIMESTAMP: 0, SUBMITTER: 1, TEMPLATE_NAME: 2, AC_CODE: 3,
  BODY: 4, PARAM_VALUES: 5, BUTTON_TEXT: 6, CATEGORY: 7,
  LANGUAGE: 8, STATUS: 9, META_ID: 10, META_STATUS: 11,
  META_CATEGORY: 12, ERROR_MESSAGE: 13
};

const BATCH_COL = {
  BATCH_ID: 0, AC_CODE: 1, CAMPAIGN_NAME: 2, PRIMARY: 3,
  BACKUP_1: 4, BACKUP_2: 5, BACKUP_3: 6, BACKUP_4: 7,
  CREATED_BY: 8, CREATED_AT: 9, STATUS: 10  // Active / Archived
};

const PROXY_COL = {
  TIMESTAMP: 0, AC_CODE: 1, TO_NUMBER: 2,
  ORIGINAL_TEMPLATE: 3, USED_TEMPLATE: 4,
  ACTION: 5, REASON: 6, MSG_ID: 7
};

const BLOCKING_STATUSES = ["Submitted", "PENDING", "APPROVED", "IN_APPEAL", "PENDING_DELETION"];
const TERMINAL_STATUSES  = ["APPROVED", "REJECTED", "DISABLED", "DELETED"];
const IMAGE_HANDLE_PROP  = "META_IMAGE_HANDLE";
const IMAGE_HANDLE_CACHE = "IMAGE_HANDLE_CURRENT";
const HEADER_URL_PROP    = "HEADER_IMAGE_URL";


// ============================================================
// WEB APP ENTRY POINT
// ============================================================
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};

  if (params.ct === "1")  return handleCtImport_(params);
  if (params.ct === "3")  return handleProxyLog_(params);
  if (params.ct === "4")  return handleProxyAlert_(params);
  if (params.ct === "5")  return handleBatchLookup_(params);
  if (params.ct === "98") return handleDebugCapture_(params);

  // Dashboard
  const userEmail = (Session.getActiveUser().getEmail() || "").toLowerCase();
  if (!isUserAllowed_(userEmail)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center;">' +
      '<h2>Access Denied</h2><p>Your account ' +
      (userEmail ? '(<b>' + escapeHtml_(userEmail) + '</b>)' : '') +
      ' is not authorised to access this dashboard.</p></body></html>'
    ).setTitle("Access Denied");
  }

  const t = HtmlService.createTemplateFromFile("Dashboard");
  t.userEmail = userEmail;
  return t.evaluate()
    .setTitle("WhatsApp Template Dashboard")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}


// ============================================================
// ?ct=1 — CT IMPORT JSON
// Called by the import Worker (which calls us).
// Returns all APPROVED UTILITY templates for the given AC Code.
// No selective filtering — full list always.
// ============================================================
function handleCtImport_(params) {
  const out = d => ContentService.createTextOutput(JSON.stringify(d)).setMimeType(ContentService.MimeType.JSON);

  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token || (params.token || "").trim() !== token) return out({ error: "Unauthorized." });

  const acCode = (params.ac || "").trim().toUpperCase();
  if (!acCode) return out({ error: "Missing ?ac= parameter." });
  const wabaId = CONFIG.WABA_MAP[acCode];
  if (!wabaId) return out({ error: `AC Code "${acCode}" not found.` });

  const metaToken = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  if (!metaToken) return out({ error: "META_TOKEN not configured." });

  const fields = "name,status,category,language,components";
  let allTemplates = [], fetchUrl =
    `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${wabaId}/message_templates` +
    `?fields=${fields}&status=APPROVED&limit=200`;
  let pages = 0;

  while (fetchUrl && pages < 20) {
    pages++;
    let resp, data;
    try {
      resp = UrlFetchApp.fetch(fetchUrl, {
        headers: { "Authorization": "Bearer " + metaToken },
        muteHttpExceptions: true
      });
      data = JSON.parse(resp.getContentText());
    } catch (e) {
      return out({ error: "Meta fetch error: " + e.toString() });
    }
    if (resp.getResponseCode() !== 200 || !data.data)
      return out({ error: "Meta API error: " + (data?.error?.message || JSON.stringify(data)) });

    allTemplates = allTemplates.concat(data.data);
    fetchUrl = data.paging?.next || null;
    if (fetchUrl) Utilities.sleep(150);
  }

  const filtered = allTemplates.filter(t => (t.category || "").toUpperCase() === "UTILITY");
  return out({ data: filtered });
}


// ============================================================
// ?ct=3 — PROXY DECISION LOG
// ============================================================
function handleProxyLog_(params) {
  const out = d => ContentService.createTextOutput(JSON.stringify(d)).setMimeType(ContentService.MimeType.JSON);

  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token || (params.token || "").trim() !== token) return out({ error: "Unauthorized." });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.PROXY_LOG);
  if (!sheet) return out({ error: "Proxy Send Log sheet not found. Run Setup." });

  sheet.appendRow([
    new Date(),
    params.acCode      || "",
    params.to          || "",
    params.originalTpl || "",
    params.usedTpl     || "",
    params.action      || "",
    params.reason      || "",
    params.msgId       || ""
  ]);
  SpreadsheetApp.flush();
  return out({ ok: true });
}


// ============================================================
// ?ct=4 — PROXY ALERT EMAIL
// ============================================================
function handleProxyAlert_(params) {
  const out = d => ContentService.createTextOutput(JSON.stringify(d)).setMimeType(ContentService.MimeType.JSON);

  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token || (params.token || "").trim() !== token) return out({ error: "Unauthorized." });

  const action      = params.action      || "UNKNOWN";
  const acCode      = params.acCode      || "";
  const originalTpl = params.originalTpl || "";
  const usedTpl     = params.usedTpl     || "";
  const reason      = params.reason      || "";
  const msgId       = params.msgId       || "";
  const to          = params.to          || "";
  const ts          = new Date().toUTCString();

  const alertEmails = PropertiesService.getScriptProperties().getProperty("ALERT_EMAILS")
                      || CONFIG.ALERT_EMAILS_DEFAULT;

  let subject, body;

  if (action === "SWAPPED") {
    subject = `⚠️ WA Template Auto-Swapped — ${acCode}`;
    body =
      `A WhatsApp template was automatically swapped mid-campaign.\n\n` +
      `Account:            ${acCode}\n` +
      `Original template:  ${originalTpl}\n` +
      `Switched to:        ${usedTpl}\n` +
      `Reason:             ${reason}\n` +
      `Recipient:          ${to}\n` +
      `Message ID:         ${msgId}\n` +
      `Time:               ${ts}\n\n` +
      `The proxy Worker detected the original template is no longer APPROVED on Meta ` +
      `and automatically switched to the next approved backup in the batch chain.\n\n` +
      `Action needed: Review the Template Batches tab on the dashboard and confirm ` +
      `the backup is sending correctly.`;
  } else if (action === "BLOCKED") {
    subject = `🚨 WA Campaign BLOCKED — ${acCode} — IMMEDIATE ACTION REQUIRED`;
    body =
      `A campaign send was BLOCKED. No valid template could be found.\n\n` +
      `Account:            ${acCode}\n` +
      `Original template:  ${originalTpl}\n` +
      `Reason:             ${reason}\n` +
      `Recipient:          ${to}\n` +
      `Message ID:         ${msgId}\n` +
      `Time:               ${ts}\n\n` +
      `All templates in the backup chain are unavailable on Meta.\n\n` +
      `IMMEDIATE ACTION REQUIRED:\n` +
      `1. Get a template approved on Meta\n` +
      `2. Update the batch on the dashboard\n` +
      `3. Resume the campaign on CleverTap`;
  } else {
    subject = `WA Proxy Alert — ${action} on ${acCode}`;
    body = `Action: ${action}\nAccount: ${acCode}\nTemplate: ${originalTpl}\nReason: ${reason}\nTime: ${ts}`;
  }

  try {
    alertEmails.split(",").forEach(email => {
      const e = email.trim();
      if (e) MailApp.sendEmail(e, subject, body);
    });
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: "Email failed: " + err.toString() });
  }
}


// ============================================================
// ?ct=5 — BATCH LOOKUP BY PRIMARY TEMPLATE NAME
// Key change from v1: lookup is by PRIMARY TEMPLATE NAME, not AC Code.
// This supports multiple simultaneous active campaigns per AC Code —
// each campaign's primary template maps to its own batch.
// ============================================================
function handleBatchLookup_(params) {
  const out = d => ContentService.createTextOutput(JSON.stringify(d)).setMimeType(ContentService.MimeType.JSON);

  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token || (params.token || "").trim() !== token) return out({ error: "Unauthorized." });

  const acCode   = (params.ac      || "").trim().toUpperCase();
  const primary  = (params.primary || "").trim().toLowerCase();
  if (!acCode)  return out({ error: "Missing ?ac= parameter." });
  if (!primary) return out({ error: "Missing ?primary= parameter." });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.BATCHES);
  if (!sheet) return out({ error: "Template Batches sheet not found." });

  const data = sheet.getDataRange().getValues();

  // Find most recent Active batch where AC Code matches AND primary = requested template
  for (let i = data.length - 1; i >= 1; i--) {
    const rowAc      = (data[i][BATCH_COL.AC_CODE] || "").toString().toUpperCase();
    const rowPrimary = (data[i][BATCH_COL.PRIMARY]  || "").toString().toLowerCase();
    const rowStatus  = (data[i][BATCH_COL.STATUS]   || "").toString().toLowerCase();

    if (rowAc !== acCode || rowStatus !== "active" || rowPrimary !== primary) continue;

    return out({
      ok:           true,
      batchId:      data[i][BATCH_COL.BATCH_ID]    || "",
      campaignName: data[i][BATCH_COL.CAMPAIGN_NAME] || "",
      acCode:       rowAc,
      primary:      rowPrimary,
      backup1:      (data[i][BATCH_COL.BACKUP_1] || "").toString().toLowerCase(),
      backup2:      (data[i][BATCH_COL.BACKUP_2] || "").toString().toLowerCase(),
      backup3:      (data[i][BATCH_COL.BACKUP_3] || "").toString().toLowerCase(),
      backup4:      (data[i][BATCH_COL.BACKUP_4] || "").toString().toLowerCase()
    });
  }

  return out({ ok: false, error: `No active batch found for template "${primary}" on ${acCode}.` });
}


// ============================================================
// ?ct=98 — DEBUG PAYLOAD CAPTURE (fires once from proxy Worker)
// ============================================================
function handleDebugCapture_(params) {
  const out = d => ContentService.createTextOutput(JSON.stringify(d)).setMimeType(ContentService.MimeType.JSON);

  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token || (params.token || "").trim() !== token) return out({ error: "Unauthorized." });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEETS.DEBUG_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEETS.DEBUG_LOG);
    sheet.appendRow(["Timestamp", "Raw Payload (first CT request)"]);
    sheet.getRange("A1:B1").setFontWeight("bold").setBackground("#fff3e0");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 600);
  }

  sheet.appendRow([new Date(), params.payload || "(empty)"]);
  SpreadsheetApp.flush();
  return out({ ok: true });
}


// ============================================================
// ACCESS CONTROL
// ============================================================
function isUserAllowed_(email) {
  if (!email) return false;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.ADMINS);
  if (!sheet) return false;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowEmail  = (data[i][0] || "").toString().toLowerCase().trim();
    const enabled   = (data[i][2] || "").toString().toLowerCase().trim();
    if (rowEmail === email && ["yes", "true", "y", "1"].includes(enabled)) return true;
  }
  return false;
}

function requireAccess_() {
  const email = (Session.getActiveUser().getEmail() || "").toLowerCase();
  if (!isUserAllowed_(email)) throw new Error("Unauthorized");
  return email;
}


// ============================================================
// FRONTEND — INIT
// ============================================================
function getInitData() {
  requireAccess_();
  return {
    acCodes:   Object.keys(CONFIG.WABA_MAP).sort(),
    maxParams: CONFIG.MAX_BODY_PARAMS,
    minParams: CONFIG.MIN_BODY_PARAMS
  };
}


// ============================================================
// FRONTEND — TEMPLATE BROWSER (CT Import Tab)
// Per-AC on-demand fetch with Script Properties cache.
// Cache key: TPL_CACHE_{acCode} → JSON: { templates, fetchedAt }
// No auto-expiry — user triggers refresh explicitly.
// ============================================================
function getTemplatesForAc(acCode) {
  requireAccess_();
  acCode = (acCode || "").toUpperCase();
  if (!CONFIG.WABA_MAP[acCode]) throw new Error(`Unknown AC Code: ${acCode}`);

  const cacheKey = "TPL_CACHE_" + acCode;
  const props    = PropertiesService.getScriptProperties();
  const cached   = props.getProperty(cacheKey);

  if (cached) {
    try {
      return JSON.parse(cached); // { templates, fetchedAt }
    } catch (e) { /* corrupt cache — refetch below */ }
  }

  return fetchAndCacheTemplates_(acCode, cacheKey);
}

function refreshTemplatesForAc(acCode) {
  requireAccess_();
  acCode = (acCode || "").toUpperCase();
  if (!CONFIG.WABA_MAP[acCode]) throw new Error(`Unknown AC Code: ${acCode}`);
  const cacheKey = "TPL_CACHE_" + acCode;
  return fetchAndCacheTemplates_(acCode, cacheKey);
}

function fetchAndCacheTemplates_(acCode, cacheKey) {
  const metaToken = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  if (!metaToken) throw new Error("META_TOKEN not configured.");
  const wabaId = CONFIG.WABA_MAP[acCode];

  const templates = [];
  let url = `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${wabaId}/message_templates` +
            `?fields=name,status,category,language,components&status=APPROVED&limit=200`;
  let pages = 0;

  while (url && pages < 20) {
    pages++;
    const resp = UrlFetchApp.fetch(url, {
      headers: { "Authorization": "Bearer " + metaToken },
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText());
    if (!data.data) break;
    data.data.forEach(t => {
      if ((t.category || "").toUpperCase() === "UTILITY") templates.push(t);
    });
    url = data.paging?.next || null;
    if (url) Utilities.sleep(150);
  }

  const result = { templates, fetchedAt: new Date().toISOString(), acCode };
  try {
    PropertiesService.getScriptProperties().setProperty(cacheKey, JSON.stringify(result));
  } catch (e) {
    // Properties has a 9KB per-property limit. If templates list is huge, store names only.
    const slim = { templates: templates.map(t => ({ name: t.name, language: t.language })), fetchedAt: result.fetchedAt, acCode, slim: true };
    PropertiesService.getScriptProperties().setProperty(cacheKey, JSON.stringify(slim));
  }
  return result;
}


// ============================================================
// FRONTEND — TEMPLATE BATCHES
// Key changes from v1:
//   - No auto-archive on new batch save
//   - Added CAMPAIGN_NAME column
//   - Multiple active batches per AC Code fully supported
//   - Lookup by primary template name (not just AC Code)
// ============================================================
function getApprovedTemplateNamesForBatch(acCode) {
  requireAccess_();
  acCode = (acCode || "").toUpperCase();
  const result = getTemplatesForAc(acCode);
  return (result.templates || []).map(t => t.name);
}

function saveBatchAssignment(payload) {
  const submitter = requireAccess_();
  if (!payload || !payload.acCode || !payload.primary)
    return { ok: false, error: "AC Code and primary template are required." };

  const acCode       = payload.acCode.toString().toUpperCase();
  const campaignName = (payload.campaignName || "").toString().trim();
  const batchId      = "batch_" + Date.now();
  const backups      = Array.isArray(payload.backups) ? payload.backups : [];

  if (!CONFIG.WABA_MAP[acCode])
    return { ok: false, error: `AC Code "${acCode}" not configured.` };

  // Warn if param counts differ (non-blocking — team may intentionally use different counts)
  // Param count check is advisory only.

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.BATCHES);
  if (!sheet) return { ok: false, error: "Template Batches sheet not found. Run Setup." };

  // Check for duplicate: same AC + same primary already active
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowAc     = (data[i][BATCH_COL.AC_CODE] || "").toString().toUpperCase();
    const rowPrim   = (data[i][BATCH_COL.PRIMARY]  || "").toString().toLowerCase();
    const rowStatus = (data[i][BATCH_COL.STATUS]   || "").toString().toLowerCase();
    if (rowAc === acCode && rowPrim === payload.primary.toLowerCase() && rowStatus === "active") {
      return { ok: false, error: `An active batch for primary "${payload.primary}" on ${acCode} already exists. Archive it first.` };
    }
  }

  sheet.appendRow([
    batchId,
    acCode,
    campaignName,
    payload.primary.toLowerCase(),
    (backups[0] || "").toLowerCase(),
    (backups[1] || "").toLowerCase(),
    (backups[2] || "").toLowerCase(),
    (backups[3] || "").toLowerCase(),
    submitter,
    new Date(),
    "Active"
  ]);

  SpreadsheetApp.flush();
  return { ok: true, batchId, by: submitter };
}

function getAllBatches() {
  requireAccess_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.BATCHES);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  return data.slice(1).reverse().slice(0, 200).map(r => ({
    batchId:      r[BATCH_COL.BATCH_ID]      || "",
    acCode:       r[BATCH_COL.AC_CODE]       || "",
    campaignName: r[BATCH_COL.CAMPAIGN_NAME] || "",
    primary:      r[BATCH_COL.PRIMARY]       || "",
    backup1:      r[BATCH_COL.BACKUP_1]      || "",
    backup2:      r[BATCH_COL.BACKUP_2]      || "",
    backup3:      r[BATCH_COL.BACKUP_3]      || "",
    backup4:      r[BATCH_COL.BACKUP_4]      || "",
    createdBy:    r[BATCH_COL.CREATED_BY]    || "",
    createdAt:    r[BATCH_COL.CREATED_AT]
                    ? new Date(r[BATCH_COL.CREATED_AT]).toISOString() : "",
    status:       r[BATCH_COL.STATUS]        || ""
  }));
}

function archiveBatch(batchId) {
  requireAccess_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.BATCHES);
  if (!sheet) return { ok: false, error: "Batch sheet not found." };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][BATCH_COL.BATCH_ID] || "").toString() === batchId.toString()) {
      sheet.getRange(i + 1, BATCH_COL.STATUS + 1).setValue("Archived");
      SpreadsheetApp.flush();
      return { ok: true };
    }
  }
  return { ok: false, error: "Batch not found." };
}

// Test the batch chain — checks live Meta status for each template
function testBatchChain(batchId) {
  requireAccess_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.BATCHES);
  if (!sheet) return { ok: false, error: "Batch sheet not found." };
  const data = sheet.getDataRange().getValues();

  let batchRow = null;
  for (let i = 1; i < data.length; i++) {
    if ((data[i][BATCH_COL.BATCH_ID] || "").toString() === batchId.toString()) {
      batchRow = data[i];
      break;
    }
  }
  if (!batchRow) return { ok: false, error: "Batch not found." };

  const acCode   = (batchRow[BATCH_COL.AC_CODE] || "").toUpperCase();
  const wabaId   = CONFIG.WABA_MAP[acCode];
  const metaToken = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  if (!wabaId || !metaToken) return { ok: false, error: "WABA ID or META_TOKEN not configured." };

  const names = [
    batchRow[BATCH_COL.PRIMARY],
    batchRow[BATCH_COL.BACKUP_1],
    batchRow[BATCH_COL.BACKUP_2],
    batchRow[BATCH_COL.BACKUP_3],
    batchRow[BATCH_COL.BACKUP_4]
  ].filter(n => n && n.toString().trim());

  const results = [];
  for (const name of names) {
    const cleanName = name.toString().toLowerCase().trim();
    try {
      const url = `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${wabaId}/message_templates` +
                  `?fields=name,status,components&name=${encodeURIComponent(cleanName)}&limit=5`;
      const resp = UrlFetchApp.fetch(url, {
        headers: { "Authorization": "Bearer " + metaToken },
        muteHttpExceptions: true
      });
      const d = JSON.parse(resp.getContentText());
      const match = (d.data || []).find(t => t.name.toLowerCase() === cleanName);
      if (match) {
        // Count {{N}} params in body component
        const bodyComp = (match.components || []).find(c => c.type === "BODY");
        const paramCount = bodyComp
          ? new Set((bodyComp.text || "").match(/\{\{(\d+)\}\}/g) || []).size
          : 0;
        results.push({ name: cleanName, status: match.status, paramCount });
      } else {
        results.push({ name: cleanName, status: "NOT_FOUND", paramCount: null });
      }
    } catch (err) {
      results.push({ name: cleanName, status: "ERROR", error: err.toString(), paramCount: null });
    }
    Utilities.sleep(200);
  }

  // Check param count consistency
  const counts = results.filter(r => r.paramCount !== null).map(r => r.paramCount);
  const paramMismatch = counts.length > 1 && !counts.every(c => c === counts[0]);

  return { ok: true, results, paramMismatch, warning: paramMismatch ? "Param count mismatch detected — backup swap may fail." : null };
}


// ============================================================
// FRONTEND — PROXY LOG
// ============================================================
function getProxyLog(opts) {
  requireAccess_();
  const limit     = Math.min(Math.max(parseInt(opts?.limit, 10) || 100, 1), 1000);
  const filterAc  = (opts?.acCode  || "").toUpperCase();
  const filterAct = (opts?.action  || "").toUpperCase(); // FORWARDED, SWAPPED, BLOCKED, "" = all

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.PROXY_LOG);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  return data.slice(1).reverse()
    .filter(r => {
      if (filterAc  && (r[PROXY_COL.AC_CODE] || "").toString().toUpperCase() !== filterAc) return false;
      if (filterAct && (r[PROXY_COL.ACTION]   || "").toString().toUpperCase() !== filterAct) return false;
      return true;
    })
    .slice(0, limit)
    .map(r => ({
      timestamp:        r[PROXY_COL.TIMESTAMP] ? new Date(r[PROXY_COL.TIMESTAMP]).toISOString() : "",
      acCode:           r[PROXY_COL.AC_CODE]           || "",
      to:               r[PROXY_COL.TO_NUMBER]          || "",
      originalTemplate: r[PROXY_COL.ORIGINAL_TEMPLATE]  || "",
      usedTemplate:     r[PROXY_COL.USED_TEMPLATE]      || "",
      action:           r[PROXY_COL.ACTION]              || "",
      reason:           r[PROXY_COL.REASON]              || "",
      msgId:            r[PROXY_COL.MSG_ID]              || ""
    }));
}

// Summary counts for the proxy log badge
function getProxyLogSummary() {
  requireAccess_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.PROXY_LOG);
  if (!sheet) return { forwarded: 0, swapped: 0, blocked: 0, recent_blocked: 0 };
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { forwarded: 0, swapped: 0, blocked: 0, recent_blocked: 0 };

  const oneHourAgo = Date.now() - 3600000;
  let forwarded = 0, swapped = 0, blocked = 0, recent_blocked = 0;

  data.slice(1).forEach(r => {
    const action = (r[PROXY_COL.ACTION] || "").toUpperCase();
    if (action === "FORWARDED") forwarded++;
    else if (action === "SWAPPED") swapped++;
    else if (action === "BLOCKED") {
      blocked++;
      const ts = r[PROXY_COL.TIMESTAMP] ? new Date(r[PROXY_COL.TIMESTAMP]).getTime() : 0;
      if (ts > oneHourAgo) recent_blocked++;
    }
  });

  return { forwarded, swapped, blocked, recent_blocked };
}


// ============================================================
// FRONTEND — TEMPLATE SUBMISSION
// ============================================================
function submitTemplate(form) {
  const submitter = requireAccess_();
  return processSubmission_({
    submitter,
    templateName: (form.templateName || "").toString().toLowerCase().replace(/\s+/g, "_").trim(),
    bodyText:     (form.body         || "").toString().trim(),
    buttonText:   (form.buttonText   || "").toString().trim(),
    acCode:       (form.acCode       || "").toString().trim().toUpperCase(),
    paramValues:  Array.isArray(form.paramValues)
                    ? form.paramValues.map(v => (v || "").toString()) : []
  });
}

function submitBulkTemplates(payload) {
  const submitter = requireAccess_();
  if (!payload || !Array.isArray(payload.templates)) return { ok: false, error: "Invalid payload." };
  const templates = payload.templates;
  if (templates.length < 1)  return { ok: false, error: "At least 1 template required." };
  if (templates.length > 10) return { ok: false, error: "Maximum 10 templates per bulk submission." };
  const acCode = (payload.acCode || "").toString().trim().toUpperCase();
  if (!acCode)                    return { ok: false, error: "AC Code required." };
  if (!CONFIG.WABA_MAP[acCode])   return { ok: false, error: `AC Code "${acCode}" not configured.` };
  const sampleValues = Array.isArray(payload.sampleValues)
    ? payload.sampleValues.map(v => (v || "").toString()) : [];

  const results = [];
  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    const res = processSubmission_({
      submitter,
      templateName: (tpl.templateName || "").toString().toLowerCase().replace(/\s+/g, "_").trim(),
      bodyText:     (tpl.body         || "").toString().trim(),
      buttonText:   (tpl.buttonText   || "").toString().trim(),
      acCode,
      paramValues:  sampleValues
    });
    results.push({
      index: i, templateName: (tpl.templateName || "").toString().trim(),
      ok: res.ok === true, metaId: res.metaId || null,
      status: res.status || null, error: res.error || null
    });
    Utilities.sleep(300);
  }
  return {
    ok: true, total: results.length,
    successCount: results.filter(r => r.ok).length, results
  };
}

function processSubmission_(opts) {
  if (!opts.templateName)
    return fail_("Template name is required.", opts);
  if (!/^[a-z0-9_]+$/.test(opts.templateName))
    return fail_("Template name: lowercase letters, numbers, underscores only.", opts);
  if (!opts.bodyText) return fail_("Body is required.", opts);
  if (!opts.acCode)   return fail_("AC Code is required.", opts);
  const wabaId = CONFIG.WABA_MAP[opts.acCode];
  if (!wabaId) return fail_(`AC Code "${opts.acCode}" not configured.`, opts);

  const prior = findLatestSubmission_(opts.templateName, opts.acCode);
  if (prior && !canResubmitStatus_(prior.status, prior.metaStatus))
    return fail_(
      `"${opts.templateName}" already exists with status "${prior.metaStatus || prior.status}". ` +
      `Resubmit is only allowed for Failed or Rejected templates.`, opts);

  const paramCount = countBodyParams_(opts.bodyText);
  if (paramCount < CONFIG.MIN_BODY_PARAMS)
    return fail_(`Body needs at least ${CONFIG.MIN_BODY_PARAMS} parameter — e.g. {{1}}`, opts);
  if (paramCount > CONFIG.MAX_BODY_PARAMS)
    return fail_(`Body has ${paramCount} parameters; max is ${CONFIG.MAX_BODY_PARAMS}`, opts);
  for (let i = 0; i < paramCount; i++)
    if (!opts.paramValues[i]?.trim())
      return fail_(`Sample value for {{${i + 1}}} is required.`, opts);

  let components;
  try {
    components = buildComponents_(opts.bodyText, opts.paramValues.slice(0, paramCount), opts.buttonText);
  } catch (e) {
    return fail_("Component build error: " + e.toString(), opts);
  }

  const token = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  if (!token) return fail_("META_TOKEN not configured.", opts);

  let responseCode, result;
  try {
    const resp = UrlFetchApp.fetch(
      `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${wabaId}/message_templates`,
      {
        method:  "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        payload: JSON.stringify({
          name: opts.templateName,
          category: CONFIG.DEFAULTS.CATEGORY,
          language: CONFIG.DEFAULTS.LANGUAGE,
          allow_category_change: false,
          components
        }),
        muteHttpExceptions: true
      }
    );
    responseCode = resp.getResponseCode();
    result = JSON.parse(resp.getContentText());
  } catch (e) {
    return fail_("Network error: " + e.toString(), opts);
  }

  if ((responseCode === 200 || responseCode === 201) && result.id) {
    writeLog_({
      submitter: opts.submitter, templateName: opts.templateName, acCode: opts.acCode,
      body: opts.bodyText, paramValues: opts.paramValues.slice(0, paramCount).join(" | "),
      buttonText: opts.buttonText, status: "Submitted", metaId: result.id,
      metaStatus: result.status || "PENDING",
      metaCategory: result.category || CONFIG.DEFAULTS.CATEGORY, error: ""
    });
    return { ok: true, metaId: result.id, status: result.status || "PENDING" };
  }

  const err = result.error || {};
  return fail_(
    `Meta error ${err.code || "?"}: ${err.message || JSON.stringify(result)}` +
    (err.error_user_msg ? " — " + err.error_user_msg : ""), opts);
}


// ============================================================
// FRONTEND — SUBMISSION HISTORY
// ============================================================
function getAllSubmissions(limit) {
  requireAccess_();
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const seen = {}, rows = [];
  for (let i = data.length - 1; i >= 1 && rows.length < limit; i--) {
    const r   = data[i];
    const key = (r[LOG_COL.TEMPLATE_NAME] || "").toString().toLowerCase() + "|" +
                (r[LOG_COL.AC_CODE] || "").toString().toUpperCase();
    if (seen[key]) continue;
    seen[key] = true;
    const status     = (r[LOG_COL.STATUS]      || "").toString();
    const metaStatus = (r[LOG_COL.META_STATUS] || "").toString();
    rows.push({
      timestamp:    r[LOG_COL.TIMESTAMP] ? new Date(r[LOG_COL.TIMESTAMP]).toISOString() : "",
      submitter:    r[LOG_COL.SUBMITTER]     || "",
      templateName: r[LOG_COL.TEMPLATE_NAME] || "",
      acCode:       r[LOG_COL.AC_CODE]       || "",
      body:         r[LOG_COL.BODY]          || "",
      paramValues:  r[LOG_COL.PARAM_VALUES]  || "",
      buttonText:   r[LOG_COL.BUTTON_TEXT]   || "",
      status, metaStatus,
      metaCategory: r[LOG_COL.META_CATEGORY] || "",
      metaId:       r[LOG_COL.META_ID]       || "",
      error:        r[LOG_COL.ERROR_MESSAGE] || "",
      canResubmit:  canResubmitStatus_(status, metaStatus)
    });
  }
  return rows;
}

// Incremental refresh — only checks non-terminal statuses, max 50 per call
function refreshAllStatuses() {
  requireAccess_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  if (!sheet) return { ok: false, error: "Submission Log sheet not found." };
  const token = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  if (!token) return { ok: false, error: "META_TOKEN not configured." };
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { ok: true, checked: 0, updated: 0 };

  // Collect unique non-terminal rows to check
  const latest = {};
  for (let i = data.length - 1; i >= 1; i--) {
    const name = (data[i][LOG_COL.TEMPLATE_NAME] || "").toString().toLowerCase();
    const ac   = (data[i][LOG_COL.AC_CODE] || "").toString().toUpperCase();
    const key  = name + "|" + ac;
    if (latest[key]) continue;
    const metaStatus = (data[i][LOG_COL.META_STATUS] || "").toString();
    if (TERMINAL_STATUSES.includes(metaStatus)) continue;
    const metaId = (data[i][LOG_COL.META_ID] || "").toString().trim();
    if (!metaId) continue;
    latest[key] = { rowIdx: i, metaId, metaStatus };
  }

  let checked = 0, updated = 0, errors = 0;
  const entries = Object.values(latest).slice(0, 50); // max 50 per refresh call

  entries.forEach(e => {
    checked++;
    try {
      const resp = UrlFetchApp.fetch(
        `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${e.metaId}` +
        `?fields=name,status,category,rejected_reason`,
        { headers: { "Authorization": "Bearer " + token }, muteHttpExceptions: true }
      );
      const result = JSON.parse(resp.getContentText());
      if (result?.status) {
        const rowNum = e.rowIdx + 1;
        if (result.status !== e.metaStatus) {
          sheet.getRange(rowNum, LOG_COL.META_STATUS + 1).setValue(result.status);
          if (TERMINAL_STATUSES.includes(result.status))
            sheet.getRange(rowNum, LOG_COL.STATUS + 1).setValue(result.status);
          updated++;
        }
        if (result.category)
          sheet.getRange(rowNum, LOG_COL.META_CATEGORY + 1).setValue(result.category);
        if (result.status === "REJECTED" && result.rejected_reason)
          sheet.getRange(rowNum, LOG_COL.ERROR_MESSAGE + 1).setValue("Rejected: " + result.rejected_reason);
      }
    } catch (err) {
      errors++;
      Logger.log("Status check failed: " + err);
    }
    Utilities.sleep(200);
  });

  SpreadsheetApp.flush();
  return { ok: true, checked, updated, errors, remaining: Math.max(0, Object.keys(latest).length - 50) };
}

function getCtProviderUrl(acCode) {
  requireAccess_();
  const email      = (Session.getActiveUser().getEmail() || "").toLowerCase();
  const providerId = CONFIG.CT_PROVIDER_MAP[(acCode || "").toUpperCase()];
  const url = providerId
    ? `${CONFIG.CT_BASE}/${CONFIG.CT_ACCOUNT_ID}/account-setup/campaigns-journeys/channels/whatsapp/providers/${providerId}/new-template`
    : `${CONFIG.CT_BASE}/${CONFIG.CT_ACCOUNT_ID}/account-setup/campaigns-journeys/channels/whatsapp`;
  return { url, email, hasDirectLink: !!providerId };
}


// ============================================================
// IMAGE HANDLE
// ============================================================
function getOrRefreshImageHandle_() {
  const thresholdMs = CONFIG.HANDLE_REFRESH_THRESHOLD_DAYS * 24 * 3600 * 1000;
  const nowMs       = Date.now();
  const cache       = CacheService.getScriptCache();
  const props       = PropertiesService.getScriptProperties();

  const cached = cache.get(IMAGE_HANDLE_CACHE);
  if (cached && isHandleUsable_(cached, nowMs, thresholdMs)) return cached;

  const stored = props.getProperty(IMAGE_HANDLE_PROP);
  if (stored && isHandleUsable_(stored, nowMs, thresholdMs)) {
    cache.put(IMAGE_HANDLE_CACHE, stored, 21600);
    return stored;
  }

  const storedUrl = props.getProperty(HEADER_URL_PROP);
  if (storedUrl) {
    const handle = uploadImageToMeta_(storedUrl);
    props.setProperty(IMAGE_HANDLE_PROP, handle);
    cache.put(IMAGE_HANDLE_CACHE, handle, 21600);
    return handle;
  }

  throw new Error("No image handle or CDN URL configured. Open Sheet → WA Dashboard (Admin) → Set Header Image URL.");
}

function isHandleUsable_(handle, nowMs, thresholdMs) {
  if (!handle) return false;
  const expiryMs = parseHandleExpiry_(handle);
  if (!expiryMs) return true;
  return (expiryMs - nowMs) > thresholdMs;
}

function parseHandleExpiry_(handle) {
  const m = (handle || "").toString().match(/:e:(\d+):/);
  return m ? parseInt(m[1], 10) * 1000 : null;
}

function getImageHandle_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(IMAGE_HANDLE_CACHE);
  if (cached) return cached;
  const stored = PropertiesService.getScriptProperties().getProperty(IMAGE_HANDLE_PROP);
  if (stored) { cache.put(IMAGE_HANDLE_CACHE, stored, 21600); return stored; }
  return "";
}

function getImageHandleInfo() {
  requireAccess_();
  const props     = PropertiesService.getScriptProperties();
  const handle    = getImageHandle_();
  const storedUrl = props.getProperty(HEADER_URL_PROP) || "";
  const info      = { set: !!handle, status: "missing", autoUrl: storedUrl, autoUrlSet: !!storedUrl };
  if (!handle) return info;
  const expiryMs = parseHandleExpiry_(handle);
  const nowMs    = Date.now();
  let daysLeft = null, hoursLeft = null;
  if (!expiryMs) {
    info.status = "unknown_expiry";
  } else {
    const msLeft = expiryMs - nowMs;
    hoursLeft    = Math.floor(msLeft / (1000 * 3600));
    daysLeft     = Math.floor(msLeft / (1000 * 3600 * 24));
    const thMs   = CONFIG.HANDLE_REFRESH_THRESHOLD_DAYS * 24 * 3600 * 1000;
    if      (msLeft <= 0)                         info.status = "expired";
    else if (msLeft < thMs && storedUrl)           info.status = "will_auto_refresh";
    else if (msLeft < thMs)                        info.status = "expiring_soon";
    else if (msLeft < 24 * 3600 * 1000 && storedUrl) info.status = "will_auto_refresh";
    else if (msLeft < 24 * 3600 * 1000)            info.status = "expiring_critical";
    else                                           info.status = "valid";
  }
  info.preview   = handle.length > 40 ? handle.substring(0, 16) + "…" + handle.substring(handle.length - 14) : handle;
  info.expiryMs  = expiryMs;
  info.expiryStr = expiryMs ? new Date(expiryMs).toUTCString() : null;
  info.daysLeft  = daysLeft;
  info.hoursLeft = hoursLeft;
  return info;
}

function setImageHandle(handle) {
  requireAccess_();
  handle = (handle || "").toString().trim();
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  if (!handle) {
    props.deleteProperty(IMAGE_HANDLE_PROP);
    cache.remove(IMAGE_HANDLE_CACHE);
    return { ok: true, cleared: true };
  }
  if (!/^\d+::/.test(handle)) return { ok: false, error: "Doesn't look like a Meta header_handle." };
  const expiryMs = parseHandleExpiry_(handle);
  if (expiryMs && expiryMs <= Date.now())
    return { ok: false, error: "Handle already expired on " + new Date(expiryMs).toUTCString() };
  props.setProperty(IMAGE_HANDLE_PROP, handle);
  cache.put(IMAGE_HANDLE_CACHE, handle, 21600);
  return { ok: true, info: getImageHandleInfo() };
}

function setHeaderImageUrl(url) {
  requireAccess_();
  url = (url || "").toString().trim();
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  if (!url) {
    props.deleteProperty(HEADER_URL_PROP);
    return { ok: true, cleared: true };
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "URL must start with https://" };
  props.setProperty(HEADER_URL_PROP, url);
  try {
    const handle = uploadImageToMeta_(url);
    props.setProperty(IMAGE_HANDLE_PROP, handle);
    cache.put(IMAGE_HANDLE_CACHE, handle, 21600);
    return { ok: true, info: getImageHandleInfo() };
  } catch (e) {
    return { ok: false, error: "URL saved, but Meta upload failed: " + e.toString() };
  }
}


// ============================================================
// COMPONENT BUILDERS
// ============================================================
function countBodyParams_(bodyText) {
  return new Set(
    (bodyText.match(/\{\{(\d+)\}\}/g) || [])
      .map(m => parseInt(m.replace(/[^\d]/g, ""), 10))
      .filter(n => n > 0)
  ).size;
}

function buildComponents_(bodyText, paramValues, buttonText) {
  const D = CONFIG.DEFAULTS;
  const components = [];

  if (D.HEADER_TYPE === "IMAGE") {
    const handle = getOrRefreshImageHandle_();
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } });
  } else if (D.HEADER_TYPE === "TEXT" && D.HEADER_TEXT) {
    components.push({ type: "HEADER", format: "TEXT", text: D.HEADER_TEXT });
  }

  const paramCount = countBodyParams_(bodyText);
  const bodyComp   = { type: "BODY", text: bodyText };
  if (paramCount > 0) {
    const samples = [];
    for (let i = 0; i < paramCount; i++)
      samples.push((paramValues[i] || ("sample_" + (i + 1))).toString());
    bodyComp.example = { body_text: [samples] };
  }
  components.push(bodyComp);

  if (D.FOOTER) components.push({ type: "FOOTER", text: D.FOOTER });

  if (buttonText && D.BUTTON_URL_TEMPLATE) {
    const btn = { type: "URL", text: buttonText, url: D.BUTTON_URL_TEMPLATE };
    if (/\{\{1\}\}/.test(D.BUTTON_URL_TEMPLATE)) btn.example = ["abc123"];
    components.push({ type: "BUTTONS", buttons: [btn] });
  }

  return components;
}


// ============================================================
// IMAGE UPLOAD TO META
// ============================================================
function uploadImageToMeta_(imageUrl) {
  const token    = PropertiesService.getScriptProperties().getProperty("META_TOKEN");
  const imgResp  = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
  if (imgResp.getResponseCode() !== 200)
    throw new Error(`Failed to fetch image (HTTP ${imgResp.getResponseCode()}): ${imageUrl}`);

  const imageBlob  = imgResp.getBlob();
  imageBlob.setContentType("image/jpeg");
  const imageBytes = imageBlob.getBytes();

  const sessionResp = UrlFetchApp.fetch(
    `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${CONFIG.APP_ID}/uploads`,
    {
      method:  "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      payload: JSON.stringify({ file_length: imageBytes.length, file_type: "image/jpeg" }),
      muteHttpExceptions: true
    }
  );
  const sessionResult = JSON.parse(sessionResp.getContentText());
  if (!sessionResult.id) throw new Error("Upload session failed: " + JSON.stringify(sessionResult));

  const uploadResp = UrlFetchApp.fetch(
    `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${sessionResult.id}`,
    {
      method:  "POST",
      headers: { "Authorization": "OAuth " + token, "Content-Type": "image/jpeg", "file_offset": "0" },
      payload: imageBytes,
      muteHttpExceptions: true
    }
  );
  const uploadResult = JSON.parse(uploadResp.getContentText());
  if (!uploadResult.h) throw new Error("Upload failed: " + JSON.stringify(uploadResult));
  return uploadResult.h;
}


// ============================================================
// LOGGING HELPERS
// ============================================================
function fail_(message, ctx) {
  writeLog_({
    submitter: ctx.submitter || "unknown", templateName: ctx.templateName || "",
    acCode: ctx.acCode || "", body: ctx.bodyText || ctx.body || "",
    paramValues: (ctx.paramValues || []).join(" | "), buttonText: ctx.buttonText || "",
    status: "Failed", metaId: "", metaStatus: "", metaCategory: "", error: message
  });
  return { ok: false, error: message };
}

function writeLog_(entry) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  if (!sheet) return;
  sheet.appendRow([
    new Date(), entry.submitter, entry.templateName, entry.acCode,
    entry.body, entry.paramValues, entry.buttonText,
    entry.metaCategory || CONFIG.DEFAULTS.CATEGORY,
    CONFIG.DEFAULTS.LANGUAGE,
    entry.status, entry.metaId || "", entry.metaStatus || "",
    entry.metaCategory || "", entry.error || ""
  ]);
}

function canResubmitStatus_(status, metaStatus) {
  return !BLOCKING_STATUSES.includes((status || "").toString()) &&
         !BLOCKING_STATUSES.includes((metaStatus || "").toString());
}

function findLatestSubmission_(templateName, acCode) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOG);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if ((data[i][LOG_COL.TEMPLATE_NAME] || "").toString().toLowerCase() === templateName.toLowerCase() &&
        (data[i][LOG_COL.AC_CODE]       || "").toString().toUpperCase() === acCode.toUpperCase())
      return {
        rowNum: i + 1,
        status:     (data[i][LOG_COL.STATUS]      || "").toString(),
        metaStatus: (data[i][LOG_COL.META_STATUS] || "").toString(),
        metaId:     (data[i][LOG_COL.META_ID]     || "").toString()
      };
  }
  return null;
}


// ============================================================
// ADMIN SETUP FUNCTIONS
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  if (!ss.getSheetByName(CONFIG.SHEETS.ADMINS)) {
    const s = ss.insertSheet(CONFIG.SHEETS.ADMINS);
    s.appendRow(["Email", "Role", "Enabled"]);
    s.appendRow([Session.getActiveUser().getEmail(), "owner", "yes"]);
    s.getRange("A1:C1").setFontWeight("bold").setBackground("#e3f2fd");
    s.setFrozenRows(1);
    s.setColumnWidths(1, 3, 220);
  }

  if (!ss.getSheetByName(CONFIG.SHEETS.LOG)) {
    const s = ss.insertSheet(CONFIG.SHEETS.LOG);
    s.appendRow(["Timestamp","Submitter","Template Name","AC Code","Body","Param Values","Button Text","Category","Language","Status","Meta ID","Meta Status","Meta Category","Error Message"]);
    s.getRange("A1:N1").setFontWeight("bold").setBackground("#e8f5e9");
    s.setFrozenRows(1);
    [160,220,200,120,300,200,150,100,80,100,180,100,100,300]
      .forEach((w, i) => s.setColumnWidth(i + 1, w));
  }

  ui.alert("Core sheets set up successfully!");
}

function setupBatchSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  if (ss.getSheetByName(CONFIG.SHEETS.BATCHES)) {
    ui.alert('"Template Batches" already exists.');
    return;
  }
  const s = ss.insertSheet(CONFIG.SHEETS.BATCHES);
  s.appendRow(["Batch ID","AC Code","Campaign Name","Primary","Backup 1","Backup 2","Backup 3","Backup 4","Created By","Created At","Status"]);
  s.getRange("A1:K1").setFontWeight("bold").setBackground("#fce4ec");
  s.setFrozenRows(1);
  [140,120,180,200,200,200,200,200,220,160,100].forEach((w, i) => s.setColumnWidth(i + 1, w));
  ui.alert('"Template Batches" created!\n\nNote: Multiple active batches per AC Code are now supported — each keyed by primary template name.');
}

function setupProxyLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  if (ss.getSheetByName(CONFIG.SHEETS.PROXY_LOG)) {
    ui.alert('"Proxy Send Log" already exists.');
    return;
  }
  const s = ss.insertSheet(CONFIG.SHEETS.PROXY_LOG);
  s.appendRow(["Timestamp","AC Code","To Number","Original Template","Used Template","Action","Reason","Msg ID"]);
  s.getRange("A1:H1").setFontWeight("bold").setBackground("#e8eaf6");
  s.setFrozenRows(1);
  [160,120,140,200,200,120,300,200].forEach((w, i) => s.setColumnWidth(i + 1, w));
  ui.alert('"Proxy Send Log" created!');
}

function setToken() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt("Meta API Token", "Paste your Meta Graph API token:", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = (r.getResponseText() || "").trim();
  if (!t) { ui.alert("No token entered."); return; }
  PropertiesService.getScriptProperties().setProperty("META_TOKEN", t);
  ui.alert("Meta API token saved.");
}

function setCtToken() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt("Shared Secret Token", "Set a secret token for import Worker + proxy Worker + dashboard:", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = (r.getResponseText() || "").trim();
  if (!t) { ui.alert("No token entered."); return; }
  PropertiesService.getScriptProperties().setProperty("CT_SECRET_TOKEN", t);
  ui.alert("CT secret token saved.\n\nUse this same value as CT_SECRET in both Cloudflare Workers.");
}

function setAlertEmails() {
  const ui      = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty("ALERT_EMAILS") || CONFIG.ALERT_EMAILS_DEFAULT;
  const r       = ui.prompt("Alert Email Recipients",
    "Comma-separated emails for SWAP/BLOCK alerts:\n\n(Current: " + current + ")",
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = (r.getResponseText() || "").trim();
  if (!t) { ui.alert("No emails entered."); return; }
  PropertiesService.getScriptProperties().setProperty("ALERT_EMAILS", t);
  ui.alert("Alert emails saved: " + t);
}

function setHeaderImageUrlMenu() {
  const ui      = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty(HEADER_URL_PROP) || "";
  const r       = ui.prompt("Set Header Image URL",
    "Paste the Zomato CDN URL for the header image.\n\n" +
    (current ? "Current: " + current + "\n\n" : "") + "Leave blank to clear.",
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const url = (r.getResponseText() || "").trim();
  if (!url) {
    PropertiesService.getScriptProperties().deleteProperty(HEADER_URL_PROP);
    ui.alert("URL cleared.");
    return;
  }
  const result = setHeaderImageUrl(url);
  if (result.ok) {
    const info = result.info;
    ui.alert("✓ URL saved and uploaded to Meta.\n\nExpires: " +
      (info.expiryStr || "unknown") + "\n\nAuto re-upload enabled — will refresh within " +
      CONFIG.HANDLE_REFRESH_THRESHOLD_DAYS + " days of expiry.");
  } else {
    ui.alert("Error: " + (result.error || "Unknown error"));
  }
}

function testCtEndpoint() {
  const ui = SpreadsheetApp.getUi();
  const r  = ui.prompt("Test CT Import Endpoint", "Enter AC Code (e.g. ZOMATOCRM5):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const acCode = (r.getResponseText() || "").trim().toUpperCase();
  if (!acCode) { ui.alert("No AC Code entered."); return; }
  const token = PropertiesService.getScriptProperties().getProperty("CT_SECRET_TOKEN");
  if (!token) { ui.alert("No CT token. Run 'Set Shared Secret Token' first."); return; }

  const output = handleCtImport_({ ct: "1", ac: acCode, token });
  const text   = output.getContent();
  let msg;
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) {
      msg = "FAILED ✗\n\n" + parsed.error;
    } else {
      const count = (parsed.data || []).length;
      const names = (parsed.data || []).slice(0, 8).map(t => "  • " + t.name).join("\n");
      msg = "SUCCESS ✓  —  " + count + " UTILITY template(s)\n\n" +
            (names || "  (none)") +
            (count > 8 ? "\n  …and " + (count - 8) + " more" : "") +
            "\n\n─────────────────\nWeb App URL:\n" + ScriptApp.getService().getUrl();
    }
  } catch (e) {
    msg = "Parse error: " + text.substring(0, 300);
  }
  ui.alert("Test: " + acCode, msg, ui.ButtonSet.OK);
}

function clearTemplateCache() {
  const ui    = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  Object.keys(CONFIG.WABA_MAP).forEach(ac => props.deleteProperty("TPL_CACHE_" + ac));
  ui.alert("Template cache cleared for all AC Codes.\nNext dashboard load will re-fetch from Meta.");
}

function getDeploymentUrl() {
  SpreadsheetApp.getUi().alert("Web App URL:\n\n" + (ScriptApp.getService().getUrl() || "Not deployed yet."));
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("WA Dashboard (Admin)")
    .addItem("1. Setup Core Sheets",         "setupSheets")
    .addItem("2. Setup Batch Sheet",          "setupBatchSheet")
    .addItem("3. Setup Proxy Log Sheet",      "setupProxyLogSheet")
    .addSeparator()
    .addItem("Set Meta API Token",            "setToken")
    .addItem("Set Header Image URL",          "setHeaderImageUrlMenu")
    .addSeparator()
    .addItem("Set Shared Secret Token",       "setCtToken")
    .addItem("Set Alert Email Recipients",    "setAlertEmails")
    .addSeparator()
    .addItem("Test CT Import Endpoint",       "testCtEndpoint")
    .addItem("Clear Template Cache",          "clearTemplateCache")
    .addItem("Show Web App URL",              "getDeploymentUrl")
    .addToUi();
}


// ============================================================
// UTIL
// ============================================================
function escapeHtml_(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
