export default async function handler(req, res) {
  const { shop } = req.query;
  
  if (!shop) {
    return res.status(400).send('Missing shop parameter.');
  }

  // FORCE AUTHENTICATION EVERY TIME
  // We no longer check the database here. We send everyone directly to Shopify.
  // Shopify will demand their admin password before letting them back into Faithox.
  
  const clientId = process.env.SHOPIFY_API_KEY;
  const scopes = 'read_products,read_orders'; 
  const redirectUri = `https://www.faithox.com/api/auth/callback`; 
  
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;

  return res.redirect(installUrl);
}
