process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

console.log('Booting edit-shipping-lines...');


import express from 'express';
import crypto from 'node:crypto';

// --- ENV (one Shopify Admin token per region/shop) ---
const {
  SHOP_DOMAIN_UK, SHOP_DOMAIN_EU, SHOP_DOMAIN_US,
  SHOPIFY_ADMIN_TOKEN_UK, SHOPIFY_ADMIN_TOKEN_EU, SHOPIFY_ADMIN_TOKEN_US,
  SHOPIFY_API_VERSION = '2025-07',
  // Keep the same optional shared-secret pattern as your existing service.
  // If you do NOT want to use secrets in Flow, leave these unset in Render.
  FLOW_SECRET_UK, FLOW_SECRET_EU, FLOW_SECRET_US,
  FETCH_TIMEOUT_MS = '10000',
  DEBUG_ERRORS = 'false'
} = process.env;

// Map shops -> region config (same pattern as your existing server.js)
const regions = [
  { code: 'UK', shop: SHOP_DOMAIN_UK, adminToken: SHOPIFY_ADMIN_TOKEN_UK, flowSecret: FLOW_SECRET_UK },
  { code: 'EU', shop: SHOP_DOMAIN_EU, adminToken: SHOPIFY_ADMIN_TOKEN_EU, flowSecret: FLOW_SECRET_EU },
  { code: 'US', shop: SHOP_DOMAIN_US, adminToken: SHOPIFY_ADMIN_TOKEN_US, flowSecret: FLOW_SECRET_US },
].filter(r => r.shop);

const byShop = new Map(regions.map(r => [r.shop, r]));
const isValidShop = s => /^[a-z0-9-]+\.myshopify\.com$/.test(String(s || ''));

const tscEq = (a, b) => {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

const timeoutMs = parseInt(FETCH_TIMEOUT_MS, 10) || 10000;
const debug = (DEBUG_ERRORS || '').toLowerCase() === 'true';

const app = express();
app.use(express.json({ limit: '200kb' }));

// ---------- utils ----------
function errRes(res, code, msg, details) {
  const body = { error: msg };
  if (debug && details) body.details = details;
  return res.status(code).json(body);
}

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

function safeJson(txt) { try { return JSON.parse(txt); } catch { return null; } }

function toOrderGid(maybeGidOrNumeric) {
  const s = String(maybeGidOrNumeric || '');
  if (!s) return null;
  if (s.startsWith('gid://shopify/Order/')) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Order/${s}`;
  return null;
}

async function shopifyGraphQL({ region, query, variables }) {
  if (!region?.adminToken) throw new Error(`Shopify token not configured for shop (${region?.code || '??'})`);
  const url = `https://${region.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const r = await timedFetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': region.adminToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await r.text();
  const json = safeJson(text);

  if (!r.ok) throw new Error(`Shopify GraphQL HTTP ${r.status}: ${text.slice(0, 800)}`);
  if (!json) throw new Error(`Shopify GraphQL non-JSON: ${text.slice(0, 800)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 1200)}`);

  return json.data;
}

function assertUserErrors(stepName, payload) {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new Error(`${stepName} userErrors: ${JSON.stringify(errs)}`);
}

// ---------- health ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    shops: regions.map(r => r.shop),
    shopifyConfigured: Object.fromEntries(regions.map(r => [r.code, Boolean(r.adminToken)])),
    apiVersion: SHOPIFY_API_VERSION
  });
});

// ---------- Flow → Order created -> edit shipping lines ----------
/**
 * POST /flow/edit-shipping-lines
 *
 * Purpose
 * -------
 * Normalizes / injects a shipping line on an order for 3PL mapping.
 * The service automatically selects the correct Shopify Admin token
 * based on `shopDomain` (no environment variables or secrets required in Flow).
 *
 * Supported modes
 * ---------------
 * 1) REPLACE
 *    - If the order already has a shipping line:
 *      • Adds a new shipping line with `targetShippingTitle`
 *      • Reuses the existing shipping price
 *      • Removes the old shipping line
 *
 * 2) ADD
 *    - If the order has NO shipping lines:
 *      • Adds a new shipping line with `targetShippingTitle`
 *      • Uses `targetShippingPrice` if provided, otherwise defaults to 0
 *
 * Body
 * ----
 * {
 *   "shopDomain": "{{shop.myshopifyDomain}}",     // required
 *   "orderGid": "{{order.id}}",                  // preferred (gid://shopify/Order/…)
 *   "orderId": "1234567890",                     // optional numeric fallback
 *   "targetShippingTitle": "DHL_PAKET::Standard",// required (3PL-normalized title)
 *   "targetShippingPrice": 0,                    // optional (used only if no shipping line exists)
 *   "dryRun": false                              // optional (true = no write, preview only)
 * }
 *
 * Headers
 * -------
 * Optional (only if FLOW_SECRET_* env vars are set in Render):
 *   X-Flow-Secret: <per-shop secret>
 *
 * Notes
 * -----
 * - Flow should ONLY send `shopDomain` + order identifiers.
 *   All shop/token resolution happens server-side.
 * - `dryRun=true` returns the detected mode ("add" | "replace")
 *   and the computed shipping price without mutating the order.
 * - Shipping line "code" is not modified; 3PL mapping must rely
 *   on `targetShippingTitle` (recommended format: CODE::Human Name).
 */

app.post('/flow/edit-shipping-lines', async (req, res) => {
  try {
    const {
      shopDomain,
      orderGid,
      orderId,
      targetShippingTitle,
      targetShippingPrice,
      dryRun = false
    } = req.body || {};

    if (!shopDomain || !isValidShop(shopDomain)) {
      return errRes(res, 400, 'Missing/invalid shopDomain', shopDomain);
    }

    const region = byShop.get(shopDomain);
    if (!region) return errRes(res, 400, `Shop not recognized: ${shopDomain}`);

    if (region.flowSecret) {
      const headerSecret = req.header('X-Flow-Secret');
      if (!tscEq(headerSecret, region.flowSecret)) return errRes(res, 401, 'Bad X-Flow-Secret');
    }

    const gid = toOrderGid(orderGid) || toOrderGid(orderId);
    if (!gid) return errRes(res, 400, 'Missing/invalid orderGid/orderId');

    if (!targetShippingTitle || !String(targetShippingTitle).trim()) {
      return errRes(res, 400, 'Missing targetShippingTitle');
    }

    // 1) Fetch order + shipping lines
    const GET_ORDER = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          shippingLines(first: 10) {
            nodes {
              id
              title
              originalPriceSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }
    `;

    const d1 = await shopifyGraphQL({ region, query: GET_ORDER, variables: { id: gid } });
    const order = d1.order;
    if (!order) return errRes(res, 404, 'Order not found');

    const current = order.shippingLines?.nodes?.[0] || null;

    // Determine price:
    // - If replacing: reuse existing price
    // - If adding: use caller price (default 0)
    let price;
    if (current) {
      const amountStr = current.originalPriceSet?.shopMoney?.amount;
      price = parseFloat(amountStr);
      if (!Number.isFinite(price)) return errRes(res, 500, 'Invalid existing shipping price', amountStr);
    } else {
      const p = (targetShippingPrice === undefined || targetShippingPrice === null)
        ? 0
        : parseFloat(targetShippingPrice);

      if (!Number.isFinite(p)) return errRes(res, 400, 'Invalid targetShippingPrice', targetShippingPrice);
      price = p;
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        shopDomain,
        orderName: order.name,
        mode: current ? 'replace' : 'add',
        from: current ? { id: current.id, title: current.title, price } : null,
        to: { title: targetShippingTitle, price }
      });
    }

    // 2) Begin order edit
    const ORDER_EDIT_BEGIN = `
      mutation Begin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `;
    const d2 = await shopifyGraphQL({ region, query: ORDER_EDIT_BEGIN, variables: { id: gid } });
    assertUserErrors('orderEditBegin', d2.orderEditBegin);
    const calculatedOrderId = d2.orderEditBegin?.calculatedOrder?.id;
    if (!calculatedOrderId) return errRes(res, 500, 'Missing calculatedOrderId');

    // 3) Add new shipping line
    const ORDER_EDIT_ADD = `
      mutation Add($id: ID!, $title: String!, $price: Money!) {
        orderEditAddShippingLine(id: $id, shippingLine: { title: $title, price: $price }) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `;
    const d3 = await shopifyGraphQL({
      region,
      query: ORDER_EDIT_ADD,
      variables: { id: calculatedOrderId, title: targetShippingTitle, price }
    });
    assertUserErrors('orderEditAddShippingLine', d3.orderEditAddShippingLine);

    // 4) Remove old shipping line only if it existed
    if (current) {
      const ORDER_EDIT_REMOVE = `
        mutation Remove($id: ID!, $shippingLineId: ID!) {
          orderEditRemoveShippingLine(id: $id, shippingLineId: $shippingLineId) {
            calculatedOrder { id }
            userErrors { field message }
          }
        }
      `;
      const d4 = await shopifyGraphQL({
        region,
        query: ORDER_EDIT_REMOVE,
        variables: { id: calculatedOrderId, shippingLineId: current.id }
      });
      assertUserErrors('orderEditRemoveShippingLine', d4.orderEditRemoveShippingLine);
    }

    // 5) Commit
    const ORDER_EDIT_COMMIT = `
      mutation Commit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Normalized shipping line via Flow") {
          order { id }
          userErrors { field message }
        }
      }
    `;
    const d5 = await shopifyGraphQL({ region, query: ORDER_EDIT_COMMIT, variables: { id: calculatedOrderId } });
    assertUserErrors('orderEditCommit', d5.orderEditCommit);

    return res.json({
      ok: true,
      shopDomain,
      orderName: order.name,
      mode: current ? 'replace' : 'add',
      from: current ? { id: current.id, title: current.title, price } : null,
      to: { title: targetShippingTitle, price }
    });
  } catch (e) {
    console.error('edit-shipping-lines error', e);
    return errRes(res, 500, 'Server error', e.stack || String(e));
  }
});

