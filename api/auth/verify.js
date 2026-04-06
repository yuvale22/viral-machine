// api/auth/verify.js
const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, token } = req.body;

  try {
    const response = await fetch(`${SUPA_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        token,
        type: 'signup'
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: 'קוד לא תקין' });
    }

    return res.status(200).json({ message: 'אימות הצליח!', session: data });
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה באימות' });
  }
};
