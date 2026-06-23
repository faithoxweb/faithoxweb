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
    const dynamicCompanyId = paymentEntity.notes?.store_name;
    
    // Safety check: Does the payload actually have a store name?
    if (!dynamicCompanyId) {
      console.error("Rejected: Missing store_name in payload notes");
      return res.status(400).send('Missing store_name parameter');
    }

    // 3. Look up the specific store's password in your new Supabase Vault
    const { data: storeData, error: storeError } = await supabase
      .from('connected_stores')
      .select('webhook_secret')
      .eq('store_name', dynamicCompanyId)
      .single();

    if (storeError || !storeData) {
      console.error(`🚨 Security Alert: Unrecognized store tried to connect: ${dynamicCompanyId}`);
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
      console.error(`🚨 Security Alert: Invalid signature for store: ${dynamicCompanyId}`);
      return res.status(400).send('Invalid signature');
    }

    // ==========================================
    // 5. IF VERIFIED: RUN YOUR ORIGINAL LOGIC
    // ==========================================
    console.log(`✅ Success! Verified payload from authorized store: ${dynamicCompanyId}`);
      
    const customerEmail = paymentEntity.email;
      
    // Generate a random 6-character alphanumeric token
    const reviewToken = crypto.randomBytes(3).toString('hex').toUpperCase(); 
      
    // --- SUPABASE DATABASE INSERTION ---
    const { error: supabaseError } = await supabase
      .from('review_tokens') 
      .insert([
        { 
          buyer_email: customerEmail, 
          token: reviewToken, 
          company_id: dynamicCompanyId 
        }
      ]);

    if (supabaseError) {
      console.error("Supabase Error:", supabaseError);
      return res.status(500).send('Failed to save token to database');
    }

    console.log(`Success! Token ${reviewToken} saved for ${customerEmail} at ${dynamicCompanyId}`);

    // --- SEND EMAIL VIA RESEND ---
    console.log(`Attempting to send email to: ${customerEmail}`);
      
    try {
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: 'onboarding@resend.dev', 
        to: customerEmail, 
        subject: `Thanks for your purchase! Leave a review for ${dynamicCompanyId}`,
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>Thank you for your payment!</h2>
            <p>We hope you love your experience. We would highly appreciate it if you could take a brief moment to leave us a review.</p>
            <p>Your unique security review token is: <strong>${reviewToken}</strong></p>
            <p>Click the button below to automatically unlock your review form without any manual entry:</p>
            <br />
            <a href="https://faithoxweb.vercel.app/embed.html?token=${reviewToken}" 
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
