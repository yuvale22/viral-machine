// api/auth/register.js
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

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;

  try {
    // 1. יצירת המשתמש בסופאבייס
    const signupRes = await fetch(SUPA_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, options: { data: { full_name } } }),
    });

    const signupData = await signupRes.json();

    if (signupData.error) {
       return res.status(400).json({ error: signupData.error.message || 'שגיאה בהרשמה' });
    }

    const userId = signupData.user?.id;
    const hasToken = !!(signupData.access_token || signupData.session?.access_token);
    const needsConfirmation = !hasToken;

    // 2. יצירת פרופיל משתמש בטבלת user_profiles
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

    // 3. החזרת תשובה לאתר
    if (needsConfirmation) {
      return res.status(200).json({
        needs_confirmation: true,
        email: email,
        message: 'שלחנו קוד אימות בן 6 ספרות למייל שלך.',
      });
    }

    return res.status(200).json({ user: signupData.user, status: 'success' });

  } catch (error) {
    return res.status(500).json({ error: 'שגיאה בשרת' });
  }
};
