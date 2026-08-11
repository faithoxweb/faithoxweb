import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// Initialize Services
const resend = new Resend(process.env.RESEND_API_KEY);
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CRITICAL FOR VERCEL: Disables default body parsing so Shopify signature works
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
        // 1. Manually read the raw buffer string
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks);

        // 2. Verify Shopify Signature
        const hmacHeader = req.headers['x-shopify-hmac-sha256'];
        const shopDomain = req.headers['x-shopify-shop-domain']; // Domain of the store sending the event
        const topic = req.headers['x-shopify-topic']; // NEW: Get the exact webhook event type
        const shopifySecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;

        if (!hmacHeader || !shopifySecret) {
            console.error('Missing HMAC header or shopify secret key configuration');
            return res.status(401).send('Unauthorized');
        }

        // Pass rawBody Buffer directly to update() without specifying 'utf8'
        const generatedHash = crypto
            .createHmac('sha256', shopifySecret)
            .update(rawBody)
            .digest('base64');

        if (generatedHash !== hmacHeader) {
            console.error('Failed Shopify Webhook Verification');
            return res.status(401).send('Unauthorized');
        }

        // 3. Parse JSON safely
        const payload = JSON.parse(rawBody.toString('utf8'));

              // --- NEW: Handle Order Webhooks ---
        if (topic === 'orders/paid') {
            console.log("🔔 [orders/paid] Webhook successfully caught!");
            
            const customerEmail = payload.email || payload.contact_email || payload.customer?.email;

            const lineItems = payload.line_items || [];

            console.log(`📧 Customer Email: ${customerEmail || "MISSING"}`);
            console.log(`🛒 Items in cart: ${lineItems.length}`);

            if (customerEmail && lineItems.length > 0) {
                // 4. Map to Faithox products
                for (const item of lineItems) {
                    const shopifyProductId = String(item.product_id);
                    console.log(`🔍 Searching Supabase for Product ID: ${shopifyProductId}`);

                    const { data: product, error: findError } = await supabaseAdmin
                        .from('products')
                        .select('product_id, store_id, name, website')
                        .eq('product_id', shopifyProductId)
                        .maybeSingle();

                    if (findError) {
                        console.error(`❌ DB Search Error:`, findError.message);
                    } else if (!product) {
                        console.log(`❌ Product ${shopifyProductId} NOT FOUND in Supabase database!`);
                    } else {
                        console.log(`✅ Product Found in DB: ${product.name}`);
                    }

                    if (findError || !product) continue; 

                    // 5. Insert Eligibility
                    const { error: insertError } = await supabaseAdmin
                        .from('eligible_reviewers')
                        .insert({
                            store_id: product.store_id,
                            product_id: product.product_id,
                            reviewer_email: customerEmail
                        });

                    // 6. Only send the email if the insert was brand new and successful
                    if (insertError) {
                        console.log(`⚠️ Eligibility insert note (likely already exists): ${insertError.message}`);
                    } else {
                        console.log(`✅ Authorized review for ${customerEmail}`);
                        
                        try {
                            // CRITICAL: We MUST await this on Vercel
                            await resend.emails.send({
                                from: 'Faithox Reviews <reviews@faithox.com>', 
                                to: customerEmail,
                                subject: `How are you liking your new ${product.name}?`,
                                html: `
                                    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                                        <h2>We hope you love your new gear!</h2>
                                        <p>As a verified buyer of the <strong>${product.name}</strong>, your opinion matters.</p>
                                        <br>
                                        <a href="${product.website}" style="padding: 12px 24px; background: #242424; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Write a Review</a>
                                    </div>
                                `
                            });
                            console.log(`✉️ Automated review request sent to ${customerEmail}`);
                        } catch (emailError) {
                            console.error('❌ Failed to send Resend email:', emailError);
                        }
                    }
                }
            } else {
                console.log("⏭️ Skipped: Missing email or no items in order.");
            }
        }


        // 7. Catch-All Success Response
        return res.status(200).send('Webhook Processed Successfully');

    } catch (error) {
        console.error('Error processing Shopify webhook:', error.message);
        return res.status(500).send('Internal Server Error');
    }
}
