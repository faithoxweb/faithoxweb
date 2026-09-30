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
        const shopDomain = req.headers['x-shopify-shop-domain']; 
        const topic = req.headers['x-shopify-topic']; 
        const shopifySecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;

        if (!hmacHeader || !shopifySecret) {
            console.error('Missing HMAC header or shopify secret key configuration');
            return res.status(401).send('Unauthorized');
        }

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

       // =============================================================
        // Handle App Uninstalled Webhook (Shopify Compliance Wipe)
        // =============================================================
        if (topic === 'app/uninstalled') {
            console.log(`🗑️ [app/uninstalled] Webhook received for ${shopDomain}. Initiating full data wipe...`);

            // 1. Remove from the Shopify connection table
            await supabaseAdmin.from('shopify_stores').delete().eq('shop', shopDomain);

            // 2. Remove from the Master stores table (This triggers the CASCADE wipe for all reviews/products!)
            const { error: deleteError } = await supabaseAdmin
                .from('stores')
                .delete()
                .eq('store_id', shopDomain);

            if (deleteError) {
                console.error(`❌ Error wiping store ${shopDomain} from Supabase:`, deleteError.message);
            } else {
                console.log(`✅ Successfully wiped ${shopDomain} and ALL associated data (Reviews, Products, etc.) to comply with Shopify policies.`);
            }
        }
        // =============================================================
        // Handle MANDATORY Shopify Privacy & GDPR Webhooks
        // =============================================================
        if (topic === 'customers/data_request') {
            // Shopify is asking to view a customer's data.
            console.log(`[GDPR] Data request received for store: ${shopDomain}`);
            return res.status(200).send('Webhook processed');
        }

        if (topic === 'customers/redact') {
            // Shopify is asking to delete a specific customer's data.
            console.log(`[GDPR] Customer redact request for store: ${shopDomain}`);
            return res.status(200).send('Webhook processed');
        }

        if (topic === 'shop/redact') {
            // Shopify is asking to delete all store data (similar to uninstall).
            console.log(`[GDPR] Shop redact request for store: ${shopDomain}`);
            await supabaseAdmin.from('stores').delete().eq('store_id', shopDomain);
            return res.status(200).send('Webhook processed');
        }
        // =============================================================
        // =============================================================
        // Handle Order Webhooks
        // =============================================================
        if (topic === 'orders/paid') {
            console.log("🔔 [orders/paid] Webhook successfully caught!");
          
            // --- DEBUG INSPECTOR ---
            console.log("🔍 DEBUG - Email fields received:", JSON.stringify({
                root_email: payload.email,
                contact_email: payload.contact_email,
                customer_obj: payload.customer,
                billing: payload.billing_address
            }, null, 2));
            
            const customerEmail = payload.email || payload.contact_email || payload.customer?.email || payload.billing_address?.email || payload.shipping_address?.email;
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

                    // 5. RESTORED: Insert Eligibility to prevent duplicate emails
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
                        
                        // 7. NEW: Generate and Insert Secure Token
                        const reviewToken = crypto.randomBytes(16).toString('hex');

                        const { error: tokenError } = await supabaseAdmin
                            .from('review_tokens')
                            .insert({
                                token: reviewToken,
                                store_id: product.store_id,
                                product_id: product.product_id,
                                buyer_email: customerEmail,
                                status: 'unused' 
                            });

                        if (tokenError) {
                            console.error(`❌ Failed to create review token:`, tokenError.message);
                        } else {
                            console.log(`✅ Secure token created for ${customerEmail}`);
                            
                            try {
                                // 8. Send the Email with the Token Link
                                await resend.emails.send({
                                    from: 'Faithox Reviews <reviews@faithox.com>', 
                                    to: customerEmail,
                                    subject: `How are you liking your new ${product.name}?`,
                                    html: `
                                        <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                                            <h2>We hope you love your new gear!</h2>
                                            <p>As a verified buyer of the <strong>${product.name}</strong>, your opinion matters.</p>
                                            <br>
                                            <!-- SECURE LINK: Only uses the unique token -->
                                            <a href="https://www.faithox.com/postareviewguest.html?token=${reviewToken}" style="padding: 12px 24px; background: #242424; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Write a Review</a>
                                        </div>
                                    `
                                });
                                console.log(`✉️ Automated review request sent to ${customerEmail}`);
                            } catch (emailError) {
                                console.error('❌ Failed to send Resend email:', emailError);
                            }
                        }
                    }
                }
            } else {
                console.log("⏭️ Skipped: Missing email or no items in order.");
            }
        }

        // 9. Catch-All Success Response
        return res.status(200).send('Webhook Processed Successfully');

    } catch (error) {
        console.error('Error processing Shopify webhook:', error.message);
        return res.status(500).send('Internal Server Error');
    }
}
