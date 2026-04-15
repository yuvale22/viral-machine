// api/cardcom/check-status.js
// POST { low_profile_code } — Polls Cardcom v11 to check transaction status.
// Returns { status: 'pending' | 'completed' | 'failed' }

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

    // Log the FULL response so we can see what Cardcom actually returns.
    // After this works in production, we can remove this for cleanliness.
    console.log('[check-status] Cardcom response for', low_profile_code, ':', JSON.stringify(lpData).slice(0, 800));

    const code = lpData.ResponseCode;

    // CASE 1: Active failures — codes 700+ are explicit failure codes from Cardcom
    if (typeof code === 'number' && code >= 700) {
      return res.status(200).json({
        status: 'failed',
        reason: lpData.Description || 'Card declined'
      });
    }

    // CASE 2: Success — ResponseCode 0 means SOMETHING completed.
    // Cardcom v11 may include any of these fields when transaction is done:
    // TranzactionInfo, TransactionInfo, TokenInfo, UIValues, DealInfo, OperationResultDescription
    // We treat ResponseCode 0 as success — even bare — because the user already submitted.
    if (code === 0) {
      const hasAnyTransactionData =
        lpData.TranzactionInfo ||
        lpData.TransactionInfo ||
        lpData.TokenInfo ||
        lpData.UIValues ||
        lpData.DealInfo ||
        lpData.OperationResultDescription ||
        lpData.LowProfileId; // even just the ID echoed back means it processed

      if (hasAnyTransactionData) {
        return res.status(200).json({
          status: 'completed',
          token: lpData.TokenInfo?.Token || lpData.TranzactionInfo?.Token || null,
          last_four: lpData.TokenInfo?.Last4Digits || lpData.TranzactionInfo?.Last4CardDigits || null,
        });
      }

      // ResponseCode 0 but no completion data — user hasn't submitted yet
      return res.status(200).json({ status: 'pending' });
    }

    // Other non-zero codes between 1-699 are usually system messages, not failures
    return res.status(200).json({ status: 'pending' });

  } catch (error) {
    console.error('[check-status] Error:', error.message);
    return res.status(200).json({ status: 'pending' });
  }
};
