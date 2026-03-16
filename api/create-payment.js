export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, userId, returnUrl, failUrl } = req.body;
  const prices = { basic: 99, pro: 199 };
  const price = prices[plan];
  if (!price) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const params = new URLSearchParams({
      TerminalNumber: '170602',
      ApiName: 'nBpN6Pz2AqazwWsiicQM',
      SumToBill: price.toString(),
      SuccessRedirectUrl: returnUrl,
      ErrorRedirectUrl: failUrl,
      MaxNumOfPayments: '1',
      Language: 'he',
      CoinID: '1',
      ProductName: 'Viral Machine - ' + plan.toUpperCase(),
      codepage: '65001',
      Operation: '1',
      DocTypeToCreate: '3',
      ReturnValue: (userId || '') + '|' + plan,
    });

    const response = await fetch('https://secure.cardcom.solutions/Interface/LowProfile.aspx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await response.text();
    const parsed = {};
    text.split('&').forEach(pair => {
      const [k, v] = pair.split('=').map(decodeURIComponent);
      if (k) parsed[k.trim()] = (v || '').trim();
    });

    if (parsed.LowProfileCode && parsed.url) {
      return res.status(200).json({ url: parsed.url });
    } else {
      return res.status(400).json({ error: parsed.Description || 'Cardcom error' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
