import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // --- STRICT SECURITY: VERCEL ENVIRONMENT VARIABLE VERIFICATION ---
    const envAdminKey = process.env.FAITHOX_MODERATION_KEY || process.env.FAITHOX_ADMIN_KEY;

    if (!envAdminKey) {
        console.error("🚨 [SECURITY ALERT]: FAITHOX_MODERATION_KEY environment variable is not set in Vercel!");
        return res.status(500).json({ 
            error: "Server configuration error: FAITHOX_MODERATION_KEY is not defined in Vercel Environment Variables. Please add FAITHOX_MODERATION_KEY in your Vercel Project Settings." 
        });
    }

    const providedKey = req.headers['x-admin-key'] || req.query.adminKey || (req.body && req.body.adminKey);

    if (!providedKey || providedKey.trim() !== envAdminKey.trim()) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Master Admin Key.' });
    }

    try {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            return res.status(500).json({ error: 'Server configuration error: Missing Supabase credentials.' });
        }

        // --- GET: FETCH REVIEWS WITH COUNTS & FILTERS ---
        if (req.method === 'GET') {
            const { filter = 'pending', store, search, limit = 100 } = req.query;

            // 1. Fetch total counts across statuses for top metric cards
            const { data: allReviews, error: countError } = await supabaseAdmin
                .from('reviews')
                .select('id, status, store_id');

            let counts = { total: 0, pending: 0, approved: 0, rejected: 0 };
            const distinctStores = new Set();

            if (!countError && allReviews) {
                counts.total = allReviews.length;
                allReviews.forEach(r => {
                    if (r.store_id) distinctStores.add(r.store_id);
                    const st = (r.status || 'approved').toLowerCase();
                    if (st === 'pending') counts.pending++;
                    else if (st === 'rejected') counts.rejected++;
                    else counts.approved++;
                });
            }

            // 2. Build filtered query
            let query = supabaseAdmin
                .from('reviews')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(parseInt(limit, 10));

            // Status filter logic
            if (filter === 'pending') {
                query = query.eq('status', 'pending');
            } else if (filter === 'approved') {
                query = query.or('status.eq.approved,status.is.null');
            } else if (filter === 'rejected') {
                query = query.eq('status', 'rejected');
            }
            // 'all' fetches without status filter

            // Store filter
            if (store && store !== 'all') {
                query = query.eq('store_id', store);
            }

            const { data: reviews, error: fetchError } = await query;

            if (fetchError) {
                console.error('Error fetching reviews for moderation:', fetchError);
                return res.status(500).json({ error: fetchError.message });
            }

            // Optional search filter in memory if provided
            let results = reviews || [];
            if (search && search.trim()) {
                const q = search.trim().toLowerCase();
                results = results.filter(r => {
                    const name = (r.reviewer_name || '').toLowerCase();
                    const email = (r.reviewer_email || '').toLowerCase();
                    const prod = (r.product_id || '').toLowerCase();
                    const text = (r.comment || r.body || '').toLowerCase();
                    const st = (r.store_id || '').toLowerCase();
                    return name.includes(q) || email.includes(q) || prod.includes(q) || text.includes(q) || st.includes(q);
                });
            }

            return res.status(200).json({
                success: true,
                reviews: results,
                counts: counts,
                stores: Array.from(distinctStores).sort()
            });
        }

        // --- POST: UPDATE REVIEW STATUS (APPROVE, REJECT, DELETE, BULK) ---
        if (req.method === 'POST') {
            const { action, reviewId, reviewIds } = req.body;

            if (!action) {
                return res.status(400).json({ error: 'Action is required (approve, reject, delete, bulk_approve, bulk_reject)' });
            }

            if (action === 'approve') {
                if (!reviewId) return res.status(400).json({ error: 'Missing reviewId' });
                const { error } = await supabaseAdmin
                    .from('reviews')
                    .update({ status: 'approved' })
                    .eq('id', reviewId);

                if (error) throw error;
                return res.status(200).json({ success: true, message: 'Review approved and published to live store!' });
            }

            if (action === 'reject') {
                if (!reviewId) return res.status(400).json({ error: 'Missing reviewId' });
                const { error } = await supabaseAdmin
                    .from('reviews')
                    .update({ status: 'rejected' })
                    .eq('id', reviewId);

                if (error) throw error;
                return res.status(200).json({ success: true, message: 'Review rejected and hidden from storefronts.' });
            }

            if (action === 'delete') {
                if (!reviewId) return res.status(400).json({ error: 'Missing reviewId' });
                const { error } = await supabaseAdmin
                    .from('reviews')
                    .delete()
                    .eq('id', reviewId);

                if (error) throw error;
                return res.status(200).json({ success: true, message: 'Review permanently deleted.' });
            }

            if (action === 'bulk_approve') {
                if (!Array.isArray(reviewIds) || reviewIds.length === 0) {
                    return res.status(400).json({ error: 'reviewIds array is required.' });
                }
                const { error } = await supabaseAdmin
                    .from('reviews')
                    .update({ status: 'approved' })
                    .in('id', reviewIds);

                if (error) throw error;
                return res.status(200).json({ success: true, message: `${reviewIds.length} reviews approved successfully!` });
            }

            if (action === 'bulk_reject') {
                if (!Array.isArray(reviewIds) || reviewIds.length === 0) {
                    return res.status(400).json({ error: 'reviewIds array is required.' });
                }
                const { error } = await supabaseAdmin
                    .from('reviews')
                    .update({ status: 'rejected' })
                    .in('id', reviewIds);

                if (error) throw error;
                return res.status(200).json({ success: true, message: `${reviewIds.length} reviews rejected.` });
            }

            return res.status(400).json({ error: `Unknown action: ${action}` });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });

    } catch (err) {
        console.error('Moderation API Error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
