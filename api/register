// api/auth/register.js
// POST — Creates Supabase Auth user + user_profiles row
// User starts as 'pending_payment' — no card collected yet

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, full_name } = req.body;
  if (!email || !password || !full_name) return res.status(400).json({ error: 'נא למלא את כל השדות' });
  if (password.length < 6) return res.status(400).json({ error: 'סיסמה חייבת להכיל לפחות 6 תווים' });

  try {
    // 1. Create Supabase Auth user
    const signupRes = await fetch(`${SUPA_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'apikey': SUPA_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, options: { data: { full_name } } }),
    });
    const signupData = await signupRes.json();
    if (!signupData.access_token) {
      throw new Error(signupData.error?.message || signupData.msg || 'Registration failed');
    }
    const userId = signupData.user.id;

    // 2. Create user_profiles row (pending_payment)
    await fetch(`${SUPA_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: {
        'apikey': SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        id: userId,
        email,
        full_name,
        status: 'pending_payment',
        onboarding_completed: false,
      }),
    });

    // 3. Return session
    return res.status(200).json({
      user: signupData.user,
      access_token: signupData.access_token,
      refresh_token: signupData.refresh_token,
      status: 'pending_payment',
    });

  } catch (error) {
    console.error('Register error:', error);
    if (error.message?.includes('already registered')) {
      return res.status(409).json({ error: 'כתובת האימייל כבר רשומה' });
    }
    return res.status(500).json({ error: error.message || 'שגיאה בהרשמה' });
  }
}register
