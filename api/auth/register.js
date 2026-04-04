// api/auth/register.js
// POST — Creates Supabase Auth user + user_profiles row
// User starts as 'pending_payment'

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, full_name } = req.body || {};
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'נא למלא את כל השדות' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'סיסמה חייבת להכיל לפחות 6 תווים' });
  }

  // Use service role key if available, fallback to anon key
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;

  try {
    // 1. Create Supabase Auth user
    const signupRes = await fetch(SUPA_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, options: { data: { full_name } } }),
    });
    const signupData = await signupRes.json();

    if (!signupData.access_token) {
      const errMsg = signupData.error?.message || signupData.msg || 'Registration failed';
      console.error('Signup error:', errMsg);
      return res.status(400).json({ error: errMsg });
    }

    const userId = signupData.user.id;

    // 2. Create user_profiles row
    const profileRes = await fetch(SUPA_URL + '/rest/v1/user_profiles', {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        id: userId,
        email: email,
        full_name: full_name,
        status: 'pending_payment',
        onboarding_completed: false,
      }),
    });

    if (!profileRes.ok) {
      const profileErr = await profileRes.json().catch(() => ({}));
      console.log('Profile insert note:', profileErr.message || profileRes.status);
      // Don't fail registration if profile insert fails (might already exist)
    }

    // 3. Return session
    return res.status(200).json({
      user: signupData.user,
      access_token: signupData.access_token,
      refresh_token: signupData.refresh_token,
      status: 'pending_payment',
    });

  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: error.message || 'שגיאה בהרשמה' });
  }
};
