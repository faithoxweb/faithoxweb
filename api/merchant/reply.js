import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { reviewId, replyText, storeId } = req.body;

    if (!reviewId || !replyText || !storeId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Initialize Supabase Admin using the secure Service Role Key (Bypasses RLS safely)
    const supabaseAdmin = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Update the review, strictly ensuring the storeId matches for security!
    const { error } = await supabaseAdmin
        .from('reviews')
        .update({ merchant_reply: replyText })
        .eq('id', reviewId)
        .eq('store_id', storeId); 

    if (error) {
        console.error('Reply Save Error:', error);
        return res.status(500).json({ error: 'Failed to save reply to database' });
    }

    return res.status(200).json({ success: true });
}
