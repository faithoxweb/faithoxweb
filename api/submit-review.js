import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    // 1. Allow CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { token, rating, guestName, reviewText, photoUrlsArray } = req.body;

    if (!token || !rating) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    try {
        // 2. Validate Token Securely
        const { data: tokenData, error: tokenError } = await supabaseAdmin
            .from('review_tokens')
            .select('store_id, product_id, buyer_email, status')
            .eq('token', token)
            .single();

        if (tokenError || !tokenData) {
            return res.status(400).json({ error: 'Invalid or expired review link.' });
        }

        if (tokenData.status === 'used') {
            return res.status(400).json({ error: 'This review link has already been used.' });
        }

        // 3. Insert Review Securely
        const { error: insertError } = await supabaseAdmin
            .from('reviews')
            .insert([{
                store_id: tokenData.store_id,
                product_id: tokenData.product_id,
                reviewer_name: guestName || "Verified Buyer",
                reviewer_email: tokenData.buyer_email,
                comment: reviewText,
                rating: parseInt(rating),
                token: token,
                photos: photoUrlsArray
            }]);

        if (insertError) throw insertError;

        // 4. Mark token as used
        await supabaseAdmin
            .from('review_tokens')
            .update({ status: 'used' })
            .eq('token', token);

        return res.status(200).json({ success: true, message: 'Review submitted successfully.' });

    } catch (error) {
        console.error('Submit review error:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
