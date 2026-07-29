import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client using Service Role Key to bypass RLS for secure backend writes
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
    // 1. Exchange temporary code for permanent Shopify Access Token
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
      return res.status(400).json({ error: 'Failed to obtain access token from Shopify' });
    }

    // 2. Save or update the store credentials in Supabase
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

    if (error) {
      console.error('Supabase save error:', error);
      return res.status(500).send('Failed to save store token.');
    }

    // 3. Redirect merchant back to their Shopify Admin embedded view or your dashboard
    return res.redirect(`https://${shop}/admin/apps`);

  } catch (err) {
    console.error('OAuth Callback Error:', err);
    return res.status(500).send('Authentication failed.');
  }
}
