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
    // 5. ✨ THE ULTIMATE MAGIC FIX: Auto-Find BOTH IDs by Name ✨
    // ==========================================
    console.log(`✅ Success! Verified payload from authorized store: ${storeName}`);
    console.log(`Searching Faithox product catalog for name: "${productName}"`);
      
    // 🟢 NEW: Auto-Find BOTH the TRUE store_id and product_id using the product_name
    const { data: productData, error: productError } = await supabase
      .from('products')
      .select('product_id, store_id')
      .ilike('name', productName) // Case-insensitive exact lookup by product name
      .limit(1)
      .single();

    if (productError || !productData) {
       console.error(`🚨 Mismatch: Could not find product named "${productName}" in Faithox database.`);
       return res.status(404).send('Product not registered in Faithox');
    }

    // We successfully pulled BOTH real relational IDs from your database
    const trueStoreId = productData.store_id;
    const trueProductId = productData.product_id;

    const customerEmail = paymentEntity.email;
      
    // Generate a random 6-character alphanumeric token
    const reviewToken = crypto.randomBytes(3).toString('hex').toUpperCase(); 
      
    // --- SUPABASE DATABASE INSERTION ---
    // 🟢 UPDATED: Using trueStoreId and trueProductId
    const { error: supabaseError } = await supabase
      .from('review_tokens') 
      .insert([
        { 
          buyer_email: customerEmail, 
          token: reviewToken, 
          store_id: trueStoreId, 
          product_id: trueProductId,
          status: 'unused'
        }
      ]);

    if (supabaseError) {
      console.error("Supabase Error:", supabaseError);
      return res.status(500).send('Failed to save token to database');
    }

    console.log(`Success! Token ${reviewToken} saved for ${customerEmail} at ${trueStoreId} (Product ID: ${trueProductId})`);

    // --- SEND EMAIL VIA RESEND ---
    console.log(`Attempting to send email to: ${customerEmail}`);
      
    try {
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: 'Faithox <noreply@faithox.com>', 
        to: customerEmail, 
        subject: `Thanks for your purchase! Leave a review for us.`,
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>Thank you for your payment!</h2>
            <p>We hope you love your experience. We would highly appreciate it if you could take a brief moment to leave us a review.</p>
            <p>Your unique security review token is: <strong>${reviewToken}</strong></p>
            <p>Click the button below to automatically unlock your review form without any manual entry:</p>
            <br />
            <a href="https://faithoxweb.vercel.app/postareviewguest.html?token=${reviewToken}" 
               style="padding: 12px 24px; background-color: #111111; color: white; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
              Leave a Review
            </a>
          </div>
        `,
      });

      if (emailError) {
        console.error("🚨 RESEND BLOCKED THE EMAIL:", emailError);
      } else {
        console.log(`✅ Email successfully dispatched! Resend ID:`, emailData);
      }

    } catch (systemError) {
      console.error("🚨 CRITICAL SYSTEM ERROR DURING EMAIL:", systemError);
    }

    return res.status(200).send('OK');

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).send('Server Error');
  }
}
