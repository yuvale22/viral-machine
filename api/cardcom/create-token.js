// api/cardcom/create-token.js
// POST — Creates a Cardcom Low Profile page for tokenization
// Returns URL for iframe where user enters card details
// No charge happens — just saves a token for future billing

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

const CARDCOM_TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
const CARDCOM_API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

async function getUserFromToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
  const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { plan } = req.body;
  const planName = plan || 'pro'; // Default trial is PRO

  // Build return URLs
  const baseUrl = req.headers.origin || 'https://viral-machine-alpha.vercel.app';
  const successUrl = `${baseUrl}?cardcom_success=1&user_id=${user.id}&plan=${planName}`;
  const failUrl = `${baseUrl}?cardcom_fail=1`;
  const ipnUrl = `${baseUrl}/api/cardcom/ipn`;

  try {
    // Create Cardcom Low Profile page
    // Operation=2 = Token only (no charge)
    // TokenToReturn=true = Return token after successful entry
    const params = new URLSearchParams({
      'TerminalNumber': CARDCOM_TERMINAL,
      'ApiName': CARDCOM_API_NAME,
      'ReturnValue': user.id,                    // Our user ID, returned in callback
      'Operation': '2',                           // 2 = Token/Authorize only (J2 = verify card)
      'Amount': '1',                              // ₪1 authorization (released immediately)
      'Currency': '1',                            // 1 = ILS
      'Language': 'he',
      'TokenToReturn': 'true',                    // Return card token
      'SuccessRedirectUrl': successUrl,
      'ErrorRedirectUrl': failUrl,
      'IndicatorUrl': ipnUrl,                     // IPN callback
      'ProductName': `YUMi ${planName.toUpperCase()} - 7 ימי ניסיון`,
      'IsIframe': 'true',                         // Optimized for iframe
      'HideCardOwnerName': 'false',
      'ShowCardOwnerEmail': 'true',
      'CardOwnerEmail': user.email || '',
      'MaxNumOfPayments': '1',
      // Custom fields for our reference
      'CustomFields.Field1': user.id,
      'CustomFields.Field2': planName,
    });

    const cardcomRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/Create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const cardcomData = await cardcomRes.json();

    if (cardcomData.ResponseCode !== '0' && cardcomData.ResponseCode !== 0) {
      console.error('Cardcom create-token error:', cardcomData);
      return res.status(400).json({
        error: 'שגיאה ביצירת דף תשלום: ' + (cardcomData.Description || 'Unknown'),
      });
    }

    // Return the Low Profile URL for iframe embedding
    return res.status(200).json({
      url: cardcomData.Url,
      low_profile_code: cardcomData.LowProfileCode,
    });

  } catch (error) {
    console.error('Cardcom create-token error:', error);
    return res.status(500).json({ error: 'שגיאה בחיבור לקארדקום' });
  }
}
