import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Supabase
// (You must use your Service Role Key here, not the public Anon Key, to securely write to the database)
  const supabaseUrl = 'https://fdjcvpsqossuiljuadkk.supabase.co';
        const supabaseKey = 'SUPABSE_SERVICE_ROLE_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

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
    // Read the raw incoming data from Razorpay
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // Verify the Security Signature
    const secret = "faithox@123"; 
    const signature = req.headers['x-razorpay-signature'];

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).send('Invalid signature');
    }

    // If it's truly Razorpay, read the payment data
    const data = JSON.parse(rawBody);
    
    if (data.event === "payment.captured") {
      const customerEmail = data.payload.payment.entity.email;
      
      // Generate a random 6-character alphanumeric token
      const reviewToken = crypto.randomBytes(3).toString('hex').toUpperCase(); 
      
      // --- SUPABASE DATABASE INSERTION ---
      // Make sure 'review_tokens' matches the exact name of your table in Supabase
      const { error } = await supabase
        .from('review_tokens') 
        .insert([
          { 
            email: customerEmail, 
            token: reviewToken, 
            company_id: "stryde" // Hardcoded for testing; we will make this dynamic later
          }
        ]);

      if (error) {
        console.error("Supabase Error:", error);
        return res.status(500).send('Failed to save token to database');
      }

      console.log(`Success! Token ${reviewToken} saved for ${customerEmail}`);
    }

    return res.status(200).send('OK');

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).send('Server Error');
  }
}
