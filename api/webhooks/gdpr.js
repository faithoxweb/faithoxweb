import { createClient } from '@supabase/supabase-js';
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

    const signatureOk = crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader || '')
    );

    if (!signatureOk) {
      return res.status(401).send('Unauthorized');
    }

    // 2. Parse the payload and initialize Supabase
    const payload = JSON.parse(rawBody);
    
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 3. Determine which GDPR webhook Shopify fired and delete the data
    switch (topic) {
      case 'customers/data_request':
        // We only log this and return a 200 OK. 
        // If a shopper asks for their data, Shopify tells the merchant, and the merchant contacts you.
        console.log(`Data requested for customer on shop: ${shopDomain}`);
        break;
      
      case 'customers/redact':
        // A shopper requested to have their data deleted. 
        console.log(`Redacting customer data for ${payload.customer?.email} on shop: ${shopDomain}`);
        
        if (payload.customer && payload.customer.email) {
          // Check your 'reviews' and 'eligible_reviewers' tables and delete matching emails
          const { error: reviewsError } = await supabase
            .from('reviews')
            .delete()
            .match({ shop: shopDomain, reviewer_email: payload.customer.email });
            
          if (reviewsError) console.error('Error deleting customer reviews:', reviewsError.message);
        }
        break;

      case 'shop/redact':
        // 48 hours after uninstall, Shopify asks you to delete all shop data.
        console.log(`Redacting all data for shop: ${shopDomain}`);
        
        // Delete the store from your main shopify_stores table.
        const { error: shopError } = await supabase
          .from('shopify_stores')
          .delete()
          .eq('shop', shopDomain);
          
        if (shopError) console.error('Error deleting shop:', shopError.message);
        break;
        
      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }

    // 4. Always return a 200 OK immediately so Shopify knows you received the request
    return res.status(200).send('Webhook received, verified, and processed');

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).send('Internal Server Error');
  }
}
