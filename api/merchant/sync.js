import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // This route uses GET because the frontend passes the shop as a URL parameter (?shop=...)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Missing shop parameter' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Missing Supabase ENV variables' });
    }

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. Fetch the merchant's data from your Supabase table
    // NOTE: If your table is named something else (like 'shops' or 'users'), change 'merchants' below!
    const { data: merchant, error } = await supabaseAdmin
      .from('merchants') 
      .select('*')
      .eq('shop', shop)
      .single();

    // 2. If no data is found yet, return safe defaults so the UI stops loading
    if (error || !merchant) {
      console.log("No merchant found for shop:", shop);
      return res.status(200).json({
        success: true,
        email: "No email on file",
        products: [],
        totalReviews: 0,
        averageRating: 0.0
      });
    }

    // 3. If data IS found, return the real data!
    return res.status(200).json({
      success: true,
      email: merchant.email || 'N/A',
      products: merchant.products || [], 
      totalReviews: merchant.total_reviews || 0,
      averageRating: merchant.average_rating || 0.0
    });

  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
