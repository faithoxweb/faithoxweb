export default function handler(req, res) {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send('Missing shop parameter.');
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const scopes = process.env.SHOPIFY_SCOPES; 
  
  // This must exactly match the path to your callback.js file on your live domain
  const redirectUri = `https://faithox.com/api/auth/callback`; 

  // Redirect the merchant to the Shopify permissions screen
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;

  return res.redirect(installUrl);
}
