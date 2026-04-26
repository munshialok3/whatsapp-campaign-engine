/**
 * ============================================================
 * WHATSAPP TEMPLATE IMPORT WORKER  v2.0
 * Cloudflare Workers
 * ============================================================
 *
 * Your CRM calls:
 *   GET https://your-import-worker.workers.dev?ac=ACCOUNT_1&token=<SHARED_SECRET>
 *
 * Worker flow:
 *   1. Validate shared secret token
 *   2. Look up WABA ID for the Account Code
 *   3. Fetch ALL pages of APPROVED templates from Meta (paginated)
 *   4. Filter to UTILITY category only
 *   5. Return JSON to CRM — full list, no selective filtering
 *
 * Cloudflare Secrets (Workers → Settings → Variables):
 *   META_TOKEN    — Meta Graph API token
 *   SHARED_SECRET — shared secret used in CRM import URL
 *
 * ============================================================
 */

// ── Account Code → WABA ID mapping ───────────────────────────
// Add your account codes and corresponding WABA IDs.
// Get WABA IDs from Meta Business Manager → WhatsApp Accounts.
const WABA_MAP = {
  "ACCOUNT_1": "YOUR_WABA_ID_1",
  "ACCOUNT_2": "YOUR_WABA_ID_2",
  // Add all your accounts here
};

const GRAPH_VERSION = "v18.0";

export default {
  async fetch(request, env) {

    if (request.method !== "GET") {
      return jsonResp({ error: "Only GET is supported." }, 405);
    }

    const url    = new URL(request.url);
    const params = url.searchParams;

    // Validate secret token
    if (!env.SHARED_SECRET) {
      return jsonResp({ error: "SHARED_SECRET not configured." }, 500);
    }
    if ((params.get("token") || "").trim() !== env.SHARED_SECRET) {
      return jsonResp({ error: "Unauthorized: invalid token." }, 401);
    }

    // Validate Account Code
    const acCode = (params.get("ac") || "").trim().toUpperCase();
    if (!acCode) {
      return jsonResp({ error: "Missing ?ac= parameter." }, 400);
    }
    const wabaId = WABA_MAP[acCode];
    if (!wabaId) {
      return jsonResp({ error: `Account Code "${acCode}" not found.` }, 400);
    }

    if (!env.META_TOKEN) {
      return jsonResp({ error: "META_TOKEN not configured." }, 500);
    }

    // Fetch ALL pages from Meta (paginated)
    const fields = "name,status,category,language,components";
    let allTemplates = [];
    let fetchUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
                   `?fields=${fields}&status=APPROVED&limit=200`;
    let pageCount = 0;

    while (fetchUrl && pageCount < 20) {
      pageCount++;
      let pageData;
      try {
        const pageResp = await fetch(fetchUrl, {
          headers: { "Authorization": `Bearer ${env.META_TOKEN}` }
        });
        pageData = await pageResp.json();
        if (!pageResp.ok || !pageData.data) {
          return jsonResp({
            error: `Meta API error (page ${pageCount}): ${pageData?.error?.message || JSON.stringify(pageData)}`
          }, 502);
        }
      } catch (err) {
        return jsonResp({ error: `Meta fetch failed (page ${pageCount}): ${err.message}` }, 502);
      }

      allTemplates = allTemplates.concat(pageData.data);
      fetchUrl = (pageData.paging && pageData.paging.next) ? pageData.paging.next : null;
    }

    // Filter UTILITY only, return full list
    const filtered = allTemplates.filter(t =>
      (t.category || "").toUpperCase() === "UTILITY"
    );

    return jsonResp({ data: filtered }, 200);
  }
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
