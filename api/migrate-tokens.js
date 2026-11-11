import { createClient } from '@supabase/supabase-js';
import { migrateLegacyStoreToken } from './_lib/shopify-token.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Strict verification using Master Admin Key
  const envAdminKey = process.env.FAITHOX_MODERATION_KEY || process.env.FAITHOX_ADMIN_KEY;
  if (!envAdminKey) {
    return res.status(500).json({
      error: 'Server configuration error: FAITHOX_MODERATION_KEY is not set in Vercel.',
    });
  }

  const providedKey = req.headers['x-admin-key'] || req.query.adminKey || (req.body && req.body.adminKey);
  if (!providedKey || providedKey.trim() !== envAdminKey.trim()) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Master Admin Key.' });
  }

  try {
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
      return res.status(500).json({ error: 'Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in Vercel.' });
    }

    // --- GET: Inspect current token migration status across all connected Shopify stores ---
    if (req.method === 'GET') {
      const { data: stores, error } = await supabaseAdmin
        .from('shopify_stores')
        .select('shop, is_active, refresh_token, expires_at, refresh_token_expires_at, installed_at')
        .order('installed_at', { ascending: false });

      if (error) throw error;

      const summary = (stores || []).map((st) => ({
        shop: st.shop,
        is_active: st.is_active !== false,
        tokenType: st.refresh_token ? 'expiring' : 'legacy_non_expiring',
        expires_at: st.expires_at || null,
        refresh_token_expires_at: st.refresh_token_expires_at || null,
        installed_at: st.installed_at || null,
      }));

      const legacyCount = summary.filter((s) => s.tokenType === 'legacy_non_expiring').length;
      const migratedCount = summary.length - legacyCount;

      return res.status(200).json({
        success: true,
        totalStores: summary.length,
        migratedCount,
        legacyCount,
        stores: summary,
      });
    }

    // --- POST: Migrate all legacy non-expiring tokens to expiring offline tokens ---
    if (req.method === 'POST') {
      const targetShop = req.body && req.body.shop ? String(req.body.shop).trim() : null;

      let query = supabaseAdmin
        .from('shopify_stores')
        .select('shop, access_token, refresh_token')
        .is('refresh_token', null);

      if (targetShop) {
        query = query.eq('shop', targetShop);
      }

      const { data: legacyStores, error } = await query;
      if (error) throw error;

      const storesToMigrate = (legacyStores || []).filter((s) => s.shop && s.access_token);
      if (storesToMigrate.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'All stored Shopify tokens in Supabase are already expiring tokens!',
          totalLegacyFound: 0,
          migratedCount: 0,
          failedCount: 0,
          results: [],
        });
      }

      const results = [];
      for (const store of storesToMigrate) {
        const result = await migrateLegacyStoreToken(supabaseAdmin, store.shop, store.access_token);
        results.push(result);
      }

      const migratedCount = results.filter((r) => r.success).length;
      const failedCount = results.length - migratedCount;

      return res.status(200).json({
        success: true,
        message: `Migrated ${migratedCount} of ${results.length} legacy token(s).`,
        totalLegacyFound: results.length,
        migratedCount,
        failedCount,
        results,
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Token migration API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

