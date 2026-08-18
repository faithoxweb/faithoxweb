import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export default async function handler(req, res) {
  // 1. Initialize Supabase INSIDE the handler to guarantee ENV variables are loaded
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY 
  );

  const { shop, code, hmac } = req.query;

  if (!shop || !code || !hmac) {
    return res.status(400).send('Missing required parameters.');
  }

  // 2. HMAC Security Validation
  const map = Object.assign({}, req.query);
  delete map['signature'];
  delete map['hmac'];
  
  const message = Object.keys(map)
    .sort()
    .map(key => `${key}=${map[key]}`)
    .join('&');
    
  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  if (generatedHash !== hmac) {
    console.error('HMAC Validation Failed!');
    return res.status(401).send('HMAC validation failed. Invalid request.');
  }

  try {
    // 3. Exchange temporary code for permanent Access Token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: code,
        expiring: 1 // Request an expiring offline token per Shopify requirements
      }),
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('Token fetch failed:', tokenData);
      return res.status(400).json({ error: 'Failed to obtain access token' });
    }

    // 4. Save store credentials in Supabase
    const { data, error } = await supabase
      .from('shopify_stores')
      .upsert(
        {
          shop: shop,
          access_token: accessToken,
          scopes: process.env.SHOPIFY_SCOPES,
          is_active: true,
          installed_at: new Date().toISOString(),
        },
        { onConflict: 'shop' } 
      );

    // If Supabase rejects it, we catch the exact error here!
    if (error) {
      console.error('SUPABASE DB ERROR:', error.message, error.details);
      throw new Error(`Database error: ${error.message}`);
    }

    // =============================================================
    // 4.5. AUTOMATICALLY REGISTER WEBHOOKS WITH SHOPIFY
    // =============================================================
    const webhooksToRegister = [
      { topic: "app/uninstalled", address: "https://www.faithox.com/api/webhooks/shopify.js" },
      { topic: "orders/paid", address: "https://www.faithox.com/api/webhooks/shopify.js" }
    ];

    for (const hook of webhooksToRegister) {
      try {
        const webhookRes = await fetch(`https://${shop}/admin/api/2026-07/webhooks.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({
            webhook: {
              topic: hook.topic,
              address: hook.address,
              format: "json"
            }
          })
        });

        if (webhookRes.ok) {
          console.log(`✅ Webhook [${hook.topic}] successfully registered for ${shop}`);
        } else {
          const errBody = await webhookRes.text();
          console.error(`❌ Webhook [${hook.topic}] failed to register:`, errBody);
        }
      } catch (whError) {
        console.error(`Webhook error during [${hook.topic}]:`, whError);
      }
    }
    // =============================================================

    // 5. Redirect merchant to their modern Shopify Admin App interface
    const shopName = shop.replace('.myshopify.com', '');
    const redirectUri = `https://admin.shopify.com/store/${shopName}/apps/${process.env.SHOPIFY_API_KEY}`;
    
    return res.redirect(redirectUri);

  } catch (err) {
    console.error('OAuth Callback Error:', err);
    return res.status(500).send('Authentication failed.');
  }
}
