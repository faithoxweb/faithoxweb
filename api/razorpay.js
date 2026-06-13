import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend'; // --- ADDED: Import Resend

// 1. Initialize Supabase correctly by fetching from environment variables
const supabaseUrl = 'https://fdjcvpsqossuiljuadkk.supabase.co';
const supabaseKey = process.env.SUPABSE_SERVICE_ROLE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

// --- ADDED: Initialize Resend ---
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
      const { error } = await supabase
        .from('review_tokens') 
        .insert([
          { 
            buyer_email: customerEmail, 
            token: reviewToken, 
            company_id: "stryde"
          }
        ]);

      if (error) {
        console.error("Supabase Error:", error);
        return res.status(500).send('Failed to save token to database');
      }

      console.log(`Success! Token ${reviewToken} saved for ${customerEmail}`);

      // --- ADDED: SEND EMAIL VIA RESEND ---
      try {
        await resend.emails.send({
          from: 'onboarding@resend.dev', // Resend's free test email address
          to: customerEmail, // Make sure to use your own email address when testing!
          subject: 'Thanks for your purchase! Leave a review for Stryde',
          html: `
            <div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>Thank you for your payment!</h2>
              <p>We hope you love your experience with Stryde. We would highly appreciate it if you could take a brief moment to leave us a review.</p>
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
        console.log(`Email successfully dispatched via Resend to ${customerEmail}`);
      } catch (emailError) {
        console.error("Resend Email Delivery Error:", emailError);
      }
    }

    return res.status(200).send('OK');

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).send('Server Error');
  }
}
