import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export default async function handler(req, res) {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter.');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: existingStore } = await supabase
    .from('shopify_stores')
    .select('access_token')
    .eq('shop', shop)
    .single();

  if (existingStore && existingStore.access_token) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await supabase.from('merchant_sessions').insert({
      token: sessionToken,
      shop: shop,
      expires_at: expiresAt
    });

    return res.redirect(`https://www.faithox.com/dashboard.html?token=${sessionToken}`);
  }

  const clientId = process.env.SHOPIFY_API_KEY;
 const scopes = 'read_products'; 
  const redirectUri = `https://www.faithox.com/api/auth/callback`; 
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;

  return res.redirect(installUrl);
}
