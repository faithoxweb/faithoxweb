import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto'; // Native Node.js module for HMAC validation

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

export default async function handler(req, res) {
  // Extract hmac alongside shop and code
  const { shop, code, hmac } = req.query;

  if (!shop || !code || !hmac) {
    return res.status(400).send('Missing required parameters.');
  }

  // 1. HMAC Security Validation (Crucial for Shopify approval)
  const map = Object.assign({}, req.query);
  delete map['signature'];
  delete map['hmac'];
  
  // Sort and format the query string for validation
  const message = Object.keys(map)
    .sort()
    .map(key => `${key}=${map[key]}`)
    .join('&');
    
  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET) // Add this to your Vercel ENV
    .update(message)
    .digest('hex');

  if (generatedHash !== hmac) {
    return res.status(401).send('HMAC validation failed. Invalid request.');
  }

  try {
    // 2. Exchange temporary code for permanent Access Token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY, // Ensure this matches your toml Client ID
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(400).json({ error: 'Failed to obtain access token' });
    }

    // 3. Save store credentials in Supabase
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
        { onConflict: 'shop' } // Make sure 'shop' is set as a UNIQUE constraint in Supabase
      );

    if (error) throw error;

    // 4. Redirect merchant to their modern Shopify Admin App interface
    const shopName = shop.replace('.myshopify.com', '');
    const redirectUri = `https://admin.shopify.com/store/${shopName}/apps/${process.env.SHOPIFY_API_KEY}`;
    
    return res.redirect(redirectUri);

  } catch (err) {
    console.error('OAuth Callback Error:', err);
    return res.status(500).send('Authentication failed.');
  }
}
