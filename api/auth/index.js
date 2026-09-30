import crypto from 'crypto';

export default async function handler(req, res) {
  const { shop } = req.query;
  
  // 1. Strict Shop Validation
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
  if (!shop || !shopRegex.test(shop)) {
    return res.status(400).send('Invalid shop parameter.');
  }

  // 2. Generate State (Nonce) for CSRF Protection
  const nonce = crypto.randomBytes(16).toString('hex');
  
  // Set it as a secure, HTTP-only cookie to read in the callback
  res.setHeader(
    'Set-Cookie', 
    `shopify_nonce=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`
  );

  // FORCE AUTHENTICATION EVERY TIME
  const clientId = process.env.SHOPIFY_API_KEY;
  const scopes = 'read_products,read_orders'; 
  const redirectUri = `https://www.faithox.com/api/auth/callback`; 
  
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`;

  return res.redirect(installUrl);
}
