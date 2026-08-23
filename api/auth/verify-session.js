import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const { data: session, error } = await supabaseAdmin
      .from('merchant_sessions')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !session) return res.status(401).json({ error: 'Invalid token.' });

    await supabaseAdmin.from('merchant_sessions').delete().eq('id', session.id);

    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Token expired.' });
    }

    return res.status(200).json({ success: true, shop: session.shop });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
