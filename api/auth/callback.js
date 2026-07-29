import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

export default async function handler(req, res) {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing shop or code parameter.');
  }

  try {
    // 1. Exchange temporary code for permanent Access Token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(400).json({ error: 'Failed to obtain access token' });
    }

    // 2. Save store credentials in Supabase
    const { error } = await supabase
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

    if (error) throw error;

    // 3. NEW STEP: Register the Webhook with Shopify
    const webhookResponse = await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken, // Using the token we just generated
      },
      body: JSON.stringify({
        webhook: {
          topic: 'orders/create', // The event you want to listen to
          address: `${process.env.HOST}/api/webhooks/shopify`, // Your new handler!
          format: 'json'
        }
      })
    });
    
    const webhookResult = await webhookResponse.json();
    console.log('Webhook Registration:', webhookResult);

    // 4. Redirect merchant to their Shopify Admin
    return res.redirect(`https://${shop}/admin/apps`);

  } catch (err) {
    console.error('OAuth Callback Error:', err);
    return res.status(500).send('Authentication failed.');
  }
}
