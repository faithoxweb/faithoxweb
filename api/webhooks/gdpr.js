import crypto from 'crypto';

// Disable default body parser to access the raw body for HMAC verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper function to read the raw body stream
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // Shopify requires apps to handle POST requests sent to mandatory compliance webhooks.
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await getRawBody(req);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic']; 
    const shopDomain = req.headers['x-shopify-shop-domain'];

    // 1. Verify the HMAC using your Shopify App Secret
    const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; 
    
    const generatedHash = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(rawBody, 'utf8')
      .digest('base64');

    // Secure, timing-safe comparison
    const signatureOk = crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader || '')
    );

    // If an invalid Shopify HMAC header is sent, the app must return a 401 Unauthorized HTTP status.
    if (!signatureOk) {
      return res.status(401).send('Unauthorized');
    }

    // 2. Determine which GDPR webhook Shopify fired
    switch (topic) {
      case 'customers/data_request':
        // Handle requests to view stored customer data.
        console.log(`Data requested for customer on shop: ${shopDomain}`);
        break;
      
      case 'customers/redact':
        // Handle requests to delete customer data.
        console.log(`Redact customer data on shop: ${shopDomain}`);
        break;

      case 'shop/redact':
        // Handle requests to delete shop data.
        // TODO: Delete the store's row in your Supabase database here
        console.log(`Redact all data for shop: ${shopDomain}`);
        break;
        
      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }

    // 3. Always return a 200 OK immediately so Shopify knows you received the request
    return res.status(200).send('Webhook received and verified');

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).send('Internal Server Error');
  }
}
