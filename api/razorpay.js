import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// 1. Initialize Supabase
const supabaseUrl = 'https://fdjcvpsqossuiljuadkk.supabase.co';
const supabaseKey = process.env.SUPABSE_SERVICE_ROLE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Tell Vercel to give us the raw text so the security check works
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 1. Read the raw incoming data from Razorpay exactly as it arrived
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // 2. Parse the data FIRST so we know which store is knocking
    const data = JSON.parse(rawBody);
    
    // Ignore anything that isn't a successful payment
    if (data.event !== "payment.captured") {
        return res.status(200).send('Event not processed');
    }

    const paymentEntity = data.payload.payment.entity;
    
    // 🟢 UPDATED: Extract store_name and product_name from the Razorpay notes payload
    const storeName = paymentEntity.notes?.store_name;
    const productName = paymentEntity.notes?.product_name; // Changed from product_id
    
    // Safety check: Does the payload actually have the required notes?
    if (!storeName || !productName) {
      console.error("Rejected: Missing store_name or product_name in payload notes");
      return res.status(400).send('Missing parameters');
    }

    // 3. Look up the specific store's password in your Supabase Vault using store_name
    const { data: storeData, error: storeError } = await supabase
      .from('connected_stores')
      .select('webhook_secret')
      .eq('store_name', storeName) 
      .single();

    if (storeError || !storeData) {
      console.error(`🚨 Security Alert: Unrecognized store tried to connect: ${storeName}`);
      return res.status(401).send('Unauthorized Store');
    }

    const clientSecret = storeData.webhook_secret;

    // 4. Verify the Razorpay Signature using their specific dynamic secret
    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error(`🚨 Security Alert: Invalid signature for store: ${storeName}`);
      return res.status(400).send('Invalid signature');
    }

        // ==========================================
    // 5. ✨ THE ULTIMATE MAGIC FIX: Direct ID Mapping ✨
    // ==========================================
    console.log(`✅ Success! Verified payload from authorized store: ${storeName}`);
      
    // 🟢 NEW: Grab the exact Faithox Product ID sent by the client
    const trueProductId = paymentEntity.notes?.faithox_product_id;

    if (!trueProductId) {
       console.error(`🚨 Missing ID: Client did not provide a faithox_product_id in the payload.`);
       return res.status(400).send('Missing Faithox Product ID');
    }

    // Since we verified the store's secret signature above, we already know the store_name is valid.
    // We just need the true store_id from connected_stores (which we queried in Step 3!)
    // Wait, let's grab the user_id/store_id from that earlier query.
    // Let's modify your Step 3 query slightly to pull 'user_id' or 'id' if needed, 
    // OR we can just use a quick lookup to get the store_id from the products table using the trueProductId:

    const { data: productData, error: productError } = await supabase
      .from('products')
      .select('store_id')
      .eq('product_id', trueProductId)
      .single();

    if (productError || !productData) {
       console.error(`🚨 Database Error: Provided faithox_product_id (${trueProductId}) does not exist in Faithox.`);
       return res.status(404).send('Invalid Faithox Product ID');
    }

    const trueStoreId = productData.store_id;
    const customerEmail = paymentEntity.email;
      
    // Generate a random 6-character alphanumeric token
    const reviewToken = crypto.randomBytes(3).toString('hex').toUpperCase(); 
