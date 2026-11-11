const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh proactively 5 minutes before expiry
const DEFAULT_EXPIRES_IN_SEC = 3600;
const DEFAULT_REFRESH_EXPIRES_IN_SEC = 90 * 24 * 60 * 60;

// Deduplicate concurrent refresh requests for the same shop within a warm serverless instance
const inFlightRefreshes = new Map();

/**
 * Normalizes Shopify OAuth token response fields for persistence in `shopify_stores`.
 */
export function computeTokenFields(tokenData, fallbackRefreshToken = null) {
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || fallbackRefreshToken || null;

  const expiresInSec = Number(tokenData.expires_in);
  const validExpiresIn = Number.isFinite(expiresInSec) && expiresInSec > 0
    ? expiresInSec
    : (refreshToken ? DEFAULT_EXPIRES_IN_SEC : null);

  const expiresAt = validExpiresIn
    ? new Date(Date.now() + validExpiresIn * 1000).toISOString()
    : null;

  const refreshExpiresInSec = Number(tokenData.refresh_token_expires_in);
  const validRefreshExpiresIn = Number.isFinite(refreshExpiresInSec) && refreshExpiresInSec > 0
    ? refreshExpiresInSec
    : (refreshToken ? DEFAULT_REFRESH_EXPIRES_IN_SEC : null);

  const refreshTokenExpiresAt = validRefreshExpiresIn
    ? new Date(Date.now() + validRefreshExpiresIn * 1000).toISOString()
    : null;

  const fields = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    refresh_token_expires_at: refreshTokenExpiresAt,
  };

  if (tokenData.scope) {
    fields.scopes = tokenData.scope;
  }

  return fields;
}

/**
 * Sends a POST request to Shopify's OAuth access_token endpoint.
 */
async function postOAuthToken(shop, formParams) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(formParams).toString(),
  });

  const rawText = await response.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  return { ok: response.ok, status: response.status, data };
}

/**
 * Exchanges a store's `refresh_token` for a fresh expiring access token and saves the rotated pair.
 */
export async function refreshStoreToken(supabaseAdmin, shop, currentRefreshToken) {
  if (!currentRefreshToken) {
    const err = new Error('Missing refresh_token; merchant re-authorization required.');
    err.code = 'REAUTH_REQUIRED';
    throw err;
  }

  if (inFlightRefreshes.has(shop)) {
    return inFlightRefreshes.get(shop);
  }

  const refreshPromise = (async () => {
    const { ok, status, data } = await postOAuthToken(shop, {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    });

    if (!ok || !data.access_token) {
      const msg = data.error_description || data.error || `HTTP ${status}`;
      const err = new Error(`Failed to refresh Shopify token for ${shop}: ${msg}`);
      // Invalid or expired refresh tokens require the merchant to reopen/re-auth the app
      if (status === 400 || status === 401 || data.error === 'invalid_grant') {
        err.code = 'REAUTH_REQUIRED';
      }
      throw err;
    }

    const updatedFields = computeTokenFields(data, currentRefreshToken);

    const { error: updateError } = await supabaseAdmin
      .from('shopify_stores')
      .update(updatedFields)
      .eq('shop', shop);

    if (updateError) {
      throw new Error(`Failed to persist refreshed token in Supabase: ${updateError.message}`);
    }

    return updatedFields.access_token;
  })();

  inFlightRefreshes.set(shop, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(shop);
  }
}

/**
 * Migrates a legacy non-expiring offline access token into an expiring offline token + refresh token.
 */
export async function migrateLegacyStoreToken(supabaseAdmin, shop, legacyAccessToken) {
  const { ok, status, data } = await postOAuthToken(shop, {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: legacyAccessToken,
    subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    expiring: '1',
  });

  if (!ok || !data.access_token || !data.refresh_token) {
    const msg = data.error_description || data.error || data.raw || `HTTP ${status}`;
    return { success: false, shop, status, error: msg };
  }

  const updatedFields = computeTokenFields(data);

  const { error: updateError } = await supabaseAdmin
    .from('shopify_stores')
    .update(updatedFields)
    .eq('shop', shop);

  if (updateError) {
    return { success: false, shop, status: 500, error: `Supabase update failed: ${updateError.message}` };
  }

  return {
    success: true,
    shop,
    expires_at: updatedFields.expires_at,
    refresh_token_expires_at: updatedFields.refresh_token_expires_at,
  };
}

/**
 * Retrieves a valid Shopify Admin access token for `shop`, refreshing proactively if expired or expiring soon.
 */
export async function getValidShopifyToken(supabaseAdmin, shop) {
  const { data: storeData, error: storeError } = await supabaseAdmin
    .from('shopify_stores')
    .select('access_token, refresh_token, expires_at, refresh_token_expires_at')
    .eq('shop', shop)
    .single();

  if (storeError || !storeData || !storeData.access_token) {
    const err = new Error('Shopify access token not found in database.');
    err.code = 'TOKEN_NOT_FOUND';
    throw err;
  }

  const { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } = storeData;

  if (!refreshToken) {
    // Legacy non-expiring token (until migrated via /api/migrate-tokens)
    return { accessToken, refreshToken: null };
  }

  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : 0;
  const needsRefresh = !expiresAtMs || Number.isNaN(expiresAtMs) || (Date.now() + REFRESH_BUFFER_MS >= expiresAtMs);

  if (!needsRefresh) {
    return { accessToken, refreshToken };
  }

  const freshAccessToken = await refreshStoreToken(supabaseAdmin, shop, refreshToken);
  return { accessToken: freshAccessToken, refreshToken };
}

/**
 * Executes a Shopify Admin API request with proactive refresh and a single reactive retry on HTTP 401.
 */
export async function shopifyAdminFetch(supabaseAdmin, shop, adminPath, fetchOptions = {}) {
  const { accessToken, refreshToken } = await getValidShopifyToken(supabaseAdmin, shop);

  const buildRequest = (token) => fetch(`https://${shop}${adminPath}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
      'X-Shopify-Access-Token': token,
    },
  });

  let response = await buildRequest(accessToken);

  if (response.status === 401 && refreshToken) {
    // Re-read the latest refresh_token from DB in case it was just rotated before retrying
    const { data: latest } = await supabaseAdmin
      .from('shopify_stores')
      .select('refresh_token')
      .eq('shop', shop)
      .single();

    const tokenToUse = (latest && latest.refresh_token) || refreshToken;
    const freshToken = await refreshStoreToken(supabaseAdmin, shop, tokenToUse);
    response = await buildRequest(freshToken);
  }

  return response;
}

