import { createClient } from '@supabase/supabase-js';
import { shopifyAdminFetch } from '../_lib/shopify-token.js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { shop } = req.query;
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
  if (!shop || !shopRegex.test(shop)) {
    return res.status(400).json({ error: 'Invalid or missing shop parameter' });
  }

  try {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Call Shopify Admin API with automatic expiring-token refresh
    const shopifyRes = await shopifyAdminFetch(
      supabaseAdmin,
      shop,
      '/admin/api/2026-04/products.json?status=active',
      { method: 'GET' }
    );

    if (!shopifyRes.ok) {
       // Catch the EXACT error message Shopify sends back
       const errorText = await shopifyRes.text();
       console.error("Shopify API rejected the request. Status:", shopifyRes.status, "Details:", errorText);
       if (shopifyRes.status === 401) {
         return res.status(401).json({
           error: 'Shopify authorization expired. Please reconnect your store.',
           reauthRequired: true,
           authUrl: `/api/auth?shop=${encodeURIComponent(shop)}`,
         });
       }
       return res.status(500).json({ error: `Shopify Error: ${errorText}` });
    }
    const shopifyData = await shopifyRes.json();
    const shopifyProducts = shopifyData.products || [];

    let syncedCount = 0;

    // 3. Save products safely into your Supabase database
    for (const sp of shopifyProducts) {
      const productPayload = {
        store_id: shop,
        product_id: sp.id.toString(),
        name: sp.title,
        image_url: sp.images && sp.images.length > 0 ? sp.images[0].src : 'https://fdjcvpsqossuiljuadkk.supabase.co/storage/v1/object/public/website%20images/Grade%20Grey.jpg',
        website: `https://${shop}/products/${sp.handle}`,
        is_product: true
      };

      // Check if product already exists in your DB to avoid duplicates
      const { data: existing } = await supabaseAdmin
        .from('products')
        .select('id')
        .eq('product_id', sp.id.toString())
        .single();

      if (existing) {
        // Update existing product
        await supabaseAdmin.from('products').update(productPayload).eq('id', existing.id);
      } else {
        // Insert new product
        await supabaseAdmin.from('products').insert([productPayload]);
      }
      
      syncedCount++;
    }

    return res.status(200).json({ success: true, count: syncedCount });

  } catch (err) {
    console.error('Sync error:', err);
    if (err.code === 'REAUTH_REQUIRED' || err.code === 'TOKEN_NOT_FOUND') {
      return res.status(401).json({
        error: 'Shopify session expired. Redirecting to reconnect your store...',
        reauthRequired: true,
        authUrl: `/api/auth?shop=${encodeURIComponent(shop)}`,
      });
    }
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
