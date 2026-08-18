import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send('Missing shop parameter.');
  }

  // 1. Initialize Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 2. Check if the store is already installed to break the loop
  const { data: existingStore } = await supabase
    .from('shopify_stores')
    .select('access_token')
    .eq('shop', shop)
    .single();

  if (existingStore && existingStore.access_token) {
    // The app is already installed! Send them to the dashboard instead of reinstalling.
    return res.redirect(`https://www.faithox.com/?shop=${shop}`);
  }

  // 3. If they are NOT installed, proceed with the normal installation flow
  const clientId = process.env.SHOPIFY_API_KEY;
  const scopes = process.env.SHOPIFY_SCOPES; 
  
  // Updated to include 'www' to perfectly match your TOML and domain configuration
  const redirectUri = `https://www.faithox.com/api/auth/callback`; 

  // Redirect the merchant to the Shopify permissions screen
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;

  return res.redirect(installUrl);
}
