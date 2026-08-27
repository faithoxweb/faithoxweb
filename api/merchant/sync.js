import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Missing shop parameter' });

  try {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Get the Shopify Access Token from your shopify_stores table
    const { data: storeData, error: storeError } = await supabaseAdmin
      .from('shopify_stores') 
      .select('access_token') 
      .eq('shop', shop) 
      .single();

    if (storeError || !storeData || !storeData.access_token) {
      console.error("Token lookup failed for:", shop);
      return res.status(400).json({ error: 'Shopify access token not found in database.' });
    }

    // 2. Ask Shopify for the products using the secure token
    const shopifyRes = await fetch(`https://${shop}/admin/api/2024-01/products.json?status=active`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': storeData.access_token,
        'Content-Type': 'application/json',
      },
    });

    if (!shopifyRes.ok) {
       console.error("Shopify API rejected the request.");
       return res.status(500).json({ error: 'Failed to fetch from Shopify API' });
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
    return res.status(500).json({ error: 'Internal server error' });
  }
}
