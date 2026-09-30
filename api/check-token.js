import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    try {
        const { data, error } = await supabaseAdmin
            .from('review_tokens')
            .select('store_id, product_id, buyer_email, status')
            .eq('token', token)
            .single();

        if (error || !data) {
            return res.status(400).json({ error: 'Invalid or expired token.' });
        }

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: 'Server error' });
    }
}
