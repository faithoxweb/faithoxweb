import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABSE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    // 1. Allow Shopify to read this file (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Only allow GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { product_id } = req.query;

    if (!product_id) {
        return res.status(400).json({ error: 'Missing product_id' });
    }

    try {
        // 3. Fetch reviews for this specific product
        const { data, error } = await supabase
            .from('reviews')
            .select('*')
            .eq('product_id', product_id);

        if (error) throw error;

        // 4. Send the reviews back to the Shopify Widget
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
