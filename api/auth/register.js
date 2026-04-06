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

    // Log full response for debugging
    console.log('Supabase signup response:', JSON.stringify(signupData).slice(0, 500));

    // Check for explicit errors
    if (signupData.error) {
      const errMsg = signupData.error.message || signupData.error || 'Registration failed';
      console.error('Signup error:', errMsg);
      if (errMsg.includes('already registered') || errMsg.includes('already been registered')) {
        return res.status(400).json({ error: 'כתובת האימייל כבר רשומה במערכת. נסה להתחבר.' });
      }
      return res.status(400).json({ error: errMsg });
    }

    // Extract user ID from various possible response formats
    const userId = signupData.user?.id || signupData.id || null;
    const userEmail = signupData.user?.email || signupData.email || email;

    // Check if this is a "fake" signup (user already exists, Supabase returns empty identities)
    const identities = signupData.user?.identities || signupData.identities || [];
    if (userId && identities.length === 0) {
      console.log('Duplicate signup detected (empty identities)');
      return res.status(400).json({ error: 'כתובת האימייל כבר רשומה. נסה להתחבר, או בדוק את תיבת המייל לקישור אימות.' });
    }

    if (!userId) {
      console.error('No user ID in signup response:', JSON.stringify(signupData).slice(0, 300));
      return res.status(400).json({ error: 'שגיאה ביצירת חשבון — נסה שוב' });
    }

    // Determine if email confirmation is required
    const hasToken = !!(signupData.access_token || signupData.session?.access_token);
    const needsConfirmation = !hasToken;

    console.log('User created:', userId, 'needs_confirmation:', needsConfirmation);

    // 2. Create user_profiles row (using service_role to bypass RLS)
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
    }

    // 3. Return — different response for confirmed vs unconfirmed
    if (needsConfirmation) {
      return res.status(200).json({
        needs_confirmation: true,
        email: email,
        message: 'נרשמת בהצלחה! שלחנו קישור אימות למייל שלך.',
      });
    }

    return res.status(200).json({
      user: signupData.user || { id: userId, email: userEmail },
      access_token: signupData.access_token || signupData.session?.access_token,
      refresh_token: signupData.refresh_token || signupData.session?.refresh_token,
      status: 'pending_payment',
      needs_confirmation: false,
    });

  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: error.message || 'שגיאה בהרשמה' });
  }
};
