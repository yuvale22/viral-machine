// api/admin/stats.js
// GET — Returns all admin dashboard data (users, payments, creators)
// SECURITY: Only the super admin email can access this endpoint

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const SUPER_ADMIN_EMAIL = 'yuval.elgisser@gmail.com';

async function getUserFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': authHeader },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the caller is super admin
  const user = await getUserFromToken(req.headers.authorization);
  if (!user || user.email !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden — admin only' });
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY env var' });
  }

  const adminHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // Fetch ALL users (bypassing RLS via service_role)
    const usersRes = await fetch(SUPA_URL + '/rest/v1/user_profiles?select=*&order=created_at.desc', { headers: adminHeaders });
    const users = usersRes.ok ? await usersRes.json() : [];

    // Fetch ALL subscriptions
    const subsRes = await fetch(SUPA_URL + '/rest/v1/subscriptions?select=*&order=created_at.desc', { headers: adminHeaders });
    const subscriptions = subsRes.ok ? await subsRes.json() : [];

    // Fetch creators
    const creatorsRes = await fetch(SUPA_URL + '/rest/v1/creators?select=*&order=created_at.desc', { headers: adminHeaders });
    const creators = creatorsRes.ok ? await creatorsRes.json() : [];

    // Fetch billing log (payments)
    const billingRes = await fetch(SUPA_URL + '/rest/v1/billing_log?select=*&status=eq.success&order=created_at.desc', { headers: adminHeaders });
    const payments = billingRes.ok ? await billingRes.json() : [];

    return res.status(200).json({
      users: users || [],
      subscriptions: subscriptions || [],
      creators: creators || [],
      payments: payments || [],
      counts: {
        total_users: (users || []).length,
        total_creators: (creators || []).length,
        total_subscriptions: (subscriptions || []).length,
      },
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    return res.status(500).json({ error: error.message });
  }
};
