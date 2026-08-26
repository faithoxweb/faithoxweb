import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS Headers (Safety net)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); 

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // 1. Initialize Supabase INSIDE the handler to guarantee ENV variables are loaded
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("CRITICAL: Missing Supabase ENV variables in Vercel.");
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 2. Fetch the session
    const { data: session, error } = await supabaseAdmin
      .from('merchant_sessions')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !session) {
      console.error("Session fetch error:", error?.message || "Session not found");
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // 3. Burn the token
    await supabaseAdmin.from('merchant_sessions').delete().eq('id', session.id);

    // 4. Check Expiration
    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Token expired.' });
    }

    // 5. Success! Return the shop domain.
    return res.status(200).json({ success: true, shop: session.shop });

  } catch (err) {
    console.error('Fatal verify-session error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
