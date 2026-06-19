// api/auth/start-trial.js
// POST — Fetches token from Cardcom v11 GetLpResult, starts 3-day free trial

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

const TRIAL_DAYS = 3;

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

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;
}

async function supaAdmin(method, path, body) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
  };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  return fetch(SUPA_URL + '/rest/v1/' + path, opts);
}

async function fetchCardcomResult(terminal, apiName, lowProfileId) {
  const url = 'https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult'
    + '?TerminalNumber=' + encodeURIComponent(terminal)
    + '&ApiName=' + encodeURIComponent(apiName)
    + '&LowProfileId=' + encodeURIComponent(lowProfileId);

  const getRes = await fetch(url, { method: 'GET' });
  const getData = await getRes.json().catch(() => null);

  if (getData && typeof getData.ResponseCode !== 'undefined') {
    return getData;
  }

  const postRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TerminalNumber: parseInt(terminal, 10),
      ApiName: apiName,
      LowProfileId: lowProfileId,
    }),
  });
  return await postRes.json().catch(() => ({}));
}

function extractExpiry(lpData) {
  if (lpData.CardExpiration) return String(lpData.CardExpiration).replace(/\D/g, '').slice(0, 4);
  const ti = lpData.TranzactionInfo || lpData.TransactionInfo || {};
  if (ti.CardMonth && ti.CardYear) {
    return String(ti.CardMonth).padStart(2, '0') + String(ti.CardYear).slice(-2);
  }
  if (ti.CardValidity) return String(ti.CardValidity).replace(/\D/g, '').slice(0, 4);
  const tok = lpData.TokenInfo || {};
  if (tok.TokenExDate) return String(tok.TokenExDate).replace(/\D/g, '').slice(0, 4);
  if (tok.CardMonth && tok.CardYear) {
    return String(tok.CardMonth).padStart(2, '0') + String(tok.CardYear).slice(-2);
  }
  if (lpData.CardMonth && lpData.CardYear) {
    return String(lpData.CardMonth).padStart(2, '0') + String(lpData.CardYear).slice(-2);
  }
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { low_profile_code, plan, cycle } = req.body || {};
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });

  const planName = plan || 'pro';
  const billingCycle = cycle || 'monthly';
  const TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

  try {
    const lpData = await fetchCardcomResult(TERMINAL, API_NAME, low_profile_code);
    console.log('[start-trial] response:', JSON.stringify(lpData).slice(0, 2000));

    if (lpData.ResponseCode !== 0) {
      return res.status(400).json({
        error: 'הכרטיס נדחה — ' + (lpData.Description || lpData.Message || 'נסה כרטיס אחר')
      });
    }

    // Extract token + card info
    const cardToken =
      lpData.Token ||
      lpData.TokenInfo?.Token ||
      lpData.TranzactionInfo?.Token ||
      lpData.TransactionInfo?.Token ||
      null;

    const lastFour =
      lpData.TokenInfo?.Last4Digits ||
      lpData.TranzactionInfo?.Last4CardDigits ||
      lpData.TransactionInfo?.Last4CardDigits ||
      lpData.TranzactionInfo?.LastCardDigitsString ||
      '****';

    const cardExpiry = extractExpiry(lpData);

    console.log('[start-trial] token:', cardToken ? 'found' : 'MISSING', 'last4:', lastFour, 'expiry:', cardExpiry || 'MISSING');

    // Calculate trial period — 3 days free, then charge
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const nextChargeDate = trialEnd.toISOString().slice(0, 10);

    // Update user profile — trialing with card saved for future charge
    const profileUpdate = {
      status: 'trialing',
      plan: planName,
      billing_cycle: billingCycle,
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      cardcom_token_exp: cardExpiry || null,
      auto_renew: true,
      next_charge_date: nextChargeDate,
      trial_ends_at: trialEnd.toISOString(),
    };

    const profileUpdateRes = await supaAdmin('PATCH', 'user_profiles?id=eq.' + user.id, profileUpdate);

    if (!profileUpdateRes.ok) {
      const errText = await profileUpdateRes.text().catch(() => '');
      console.error('[start-trial] Profile update failed:', profileUpdateRes.status, errText);
      return res.status(500).json({ error: 'נכשל בעדכון פרופיל — צור קשר לתמיכה' });
    }

    return res.status(200).json({
      plan: planName,
      status: 'trialing',
      trial_end: trialEnd.toISOString(),
      next_charge: nextChargeDate,
      last_four: lastFour,
    });

  } catch (error) {
    console.error('[start-trial] Unexpected error:', error.message);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
};
