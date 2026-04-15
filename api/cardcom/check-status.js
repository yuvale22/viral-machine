// api/cardcom/check-status.js
const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { low_profile_code } = req.body || {};
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });

  const TERMINAL = parseInt(process.env.CARDCOM_TERMINAL || '170602', 10);
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

  try {
    const lpRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetLowProfileResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        TerminalNumber: TERMINAL,
        ApiName: API_NAME,
        LowProfileId: low_profile_code,
      }),
    });

    const lpData = await lpRes.json();

    if (lpData.ResponseCode === 0 && lpData.TranzactionInfo) {
      return res.status(200).json({ status: 'completed' });
    }
    if (lpData.ResponseCode === 0) {
      return res.status(200).json({ status: 'pending' });
    }
    if (lpData.ResponseCode >= 700) {
      return res.status(200).json({ status: 'failed', reason: lpData.Description || 'Card declined' });
    }
    return res.status(200).json({ status: 'pending' });

  } catch (error) {
    console.error('check-status error:', error);
    return res.status(200).json({ status: 'pending' });
  }
};
