// api/auth/start-trial.js
// POST — Called after user returns from Cardcom payment page
// Fetches the saved token from Cardcom's LowProfile result
// Creates subscription record with 7-day trial

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const CARDCOM_TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
const CARDCOM_API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

const PLAN_PRICES = { basic: 9900, pro: 19900, agency: 39900 }; // agorot

async function getUserFromToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
  const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function supaAdmin(method, path, body) {
  const opts = {
    method,
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, opts);
  if (method === 'PATCH' || method === 'DELETE') return r;
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { low_profile_code, plan } = req.body;
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });

  const planName = plan || 'pro';
  const amount = PLAN_PRICES[planName] || PLAN_PRICES.pro;

  try {
    // 1. Fetch token result from Cardcom LowProfile
    const lpParams = new URLSearchParams({
      'TerminalNumber': CARDCOM_TERMINAL,
      'ApiName': CARDCOM_API_NAME,
      'LowProfileCode': low_profile_code,
    });

    const lpRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetResults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: lpParams.toString(),
    });
    const lpData = await lpRes.json();

    if (lpData.ResponseCode !== '0' && lpData.ResponseCode !== 0) {
      console.error('Cardcom LpResult error:', lpData);
      return res.status(400).json({
        error: 'הכרטיס נדחה — ' + (lpData.Description || 'נסה כרטיס אחר'),
      });
    }

    const cardToken = lpData.Token;
    const lastFour = lpData.Last4CardDigits || lpData.CardNumber?.slice(-4) || '****';
    const cardExpiry = lpData.CardValidity || '';

    if (!cardToken) {
      return res.status(400).json({ error: 'לא התקבל אסימון מקארדקום — נסה שוב' });
    }

    // 2. Calculate trial end (7 days from now)
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const periodStart = now.toISOString();
    const periodEnd = trialEnd.toISOString();

    // 3. Save subscription (using service_role to bypass RLS)
    const subResult = await supaAdmin('POST', 'subscriptions', {
      user_id: user.id,
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      cardcom_expiry: cardExpiry,
      plan: planName,
      status: 'trialing',
      amount_ils: amount,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      trial_end: periodEnd,
      last_charge_status: 'pending',
    });

    // 4. Update user profile
    await supaAdmin('PATCH', `user_profiles?id=eq.${user.id}`, {
      status: 'trialing',
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      trial_ends_at: periodEnd,
    });

    // 5. Return success
    return res.status(200).json({
      plan: planName,
      status: 'trialing',
      trial_end: periodEnd,
      trial_end_display: trialEnd.toLocaleDateString('he-IL'),
      last_four: lastFour,
    });

  } catch (error) {
    console.error('Start trial error:', error);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
}
