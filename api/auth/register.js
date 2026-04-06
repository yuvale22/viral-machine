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

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;

  try {
    // 1. Create Supabase Auth user
    const signupRes = await fetch(SUPA_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, options: { data: { full_name } } }),
    });

    if (signupRes.status === 429) {
      return res.status(429).json({ error: 'יותר מדי ניסיונות הרשמה — נסה שוב בעוד כמה דקות' });
    }

    const signupData = await signupRes.json();

    if (signupData.error) {
      const errMsg = signupData.error.message || 'Registration failed';
      if (errMsg.includes('already registered')) {
        return res.status(400).json({ error: 'כתובת האימייל כבר רשומה במערכת.' });
      }
      return res.status(400).json({ error: errMsg });
    }

    const userId = signupData.user?.id || signupData.id || null;
    const hasToken = !!(signupData.access_token || signupData.session?.access_token);
    const needsConfirmation = !hasToken;

    // 2. Create user_profiles row
    await fetch(SUPA_URL + '/rest/v1/user_profiles', {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: userId,
        email: email,
        full_name: full_name,
        status: 'pending_payment',
        onboarding_completed: false,
      }),
    });

    // 3. Return — עדכנתי כאן את ההודעה לקוד במקום קישור
    if (needsConfirmation) {
      return res.status(200).json({
        needs_confirmation: true,
        email: email,
        message: 'נרשמת בהצלחה! שלחנו קוד אימות בן 6 ספרות למייל שלך.', // <--- השינוי כאן
      });
    }

    return res.status(200).json({
      user: signupData.user || { id: userId, email: email },
      access_token: signupData.access_token || signupData.session?.access_token,
      status: 'pending_payment',
      needs_confirmation: false,
    });

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בהרשמה' });
  }
};
