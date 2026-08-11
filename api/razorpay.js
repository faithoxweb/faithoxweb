import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// 1. Initialize Supabase
const supabaseUrl = 'https://fdjcvpsqossuiljuadkk.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
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
    // 1. Read the raw incoming data from Razorpay
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // 2. Parse the data
    const data = JSON.parse(rawBody);
    
    if (data.event !== "payment.captured") {
        return res.status(200).send('Event not processed');
    }

    const paymentEntity = data.payload.payment.entity;
    
// =============================================================
    // 3. SMART PAYLOAD CHECK (Shopify vs Custom Website)
    // =============================================================
    const notes = paymentEntity.notes || {};
    const storeName = notes.store_name;
    const trueProductId = notes.faithox_product_id;

    // Detect if this payment originated from a Shopify order
    const isShopifyOrder = 
      notes.shopify_order_id || 
      notes.order_id || 
      (paymentEntity.description && paymentEntity.description.toLowerCase().includes('order #'));

    if (!storeName || !trueProductId) {
      if (isShopifyOrder) {
        // 1. Normal Shopify Order -> Log informatively and return 200 OK
        console.log("ℹ️ [SHOPIFY ORDER DETECTED]: Skipping Razorpay processing (handled by api/webhooks/shopify).");
        return res.status(200).send('Skipped: Shopify Order');
      } else {
        // 2. Custom Website Bug -> Log CRITICAL ERROR in Vercel, but return 200 OK so Razorpay stays active
        console.error("🚨 [CUSTOM WEBSITE BUG DETECTED]: Payment captured, but missing 'store_name' or 'faithox_product_id' in Razorpay notes!");
        console.error("Received payload notes:", JSON.stringify(notes));
        return res.status(200).send('Skipped: Missing custom website notes');
      }
    }
    // =============================================================


    // 3. Look up store secret
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

    // 4. Verify the Razorpay Signature 
    const signature = req.headers['x-razorpay-signature'];
    
    if (!signature) {
      console.error(`🚨 Security Alert: Missing Razorpay signature header`);
      return res.status(400).send('Missing signature');
    }

    const expectedSignature = crypto
      .createHmac('sha256', clientSecret)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error(`🚨 Security Alert: Invalid signature for store: ${storeName}`);
      return res.status(400).send('Invalid signature');
    }

    // 5. Direct ID Mapping & Database Insertion
    console.log(`✅ Success! Verified payload from authorized store: ${storeName}`);
      
    const { data: productData, error: productError } = await supabase
      .from('products')
      .select('store_id')
      .eq('product_id', trueProductId)
      .single();

    if (productError || !productData) {
       console.error(`🚨 Database Error: Provided faithox_product_id (${trueProductId}) does not exist.`);
       return res.status(404).send('Invalid Faithox Product ID');
    }

    const trueStoreId = productData.store_id;
    const customerEmail = paymentEntity.email;
    const reviewToken = crypto.randomBytes(3).toString('hex').toUpperCase(); 
      
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

    console.log(`Success! Token ${reviewToken} saved for ${customerEmail}`);

    // --- SEND EMAIL VIA RESEND ---
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
            <p>Click the button below to automatically unlock your review form:</p>
            <br />
            <a href="https://faithox.com/postareviewguest.html?token=${reviewToken}" 
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
