// api/search-tiktok.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const RAPID_KEY = process.env.RAPIDAPI_KEY;  // ← תוקן: שם נכון
  if (!RAPID_KEY) {
    console.error('RAPIDAPI_KEY missing from env');
    return res.status(500).json({ error: 'RapidAPI key not configured' });
  }

  const { endpoint, params } = req.body || {};
  const allowedEndpoints = ['feed/search', 'user/posts', 'user/search'];
  if (!allowedEndpoints.includes(endpoint)) {
    return res.status(400).json({ error: 'Invalid endpoint' });
  }

  try {
    const query = new URLSearchParams(params || {}).toString();
    const url = `https://tiktok-scraper7.p.rapidapi.com/${endpoint}?${query}`;
    
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': RAPID_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    
    if (!response.ok) {
      console.error('TikTok API error:', response.status);
      return res.status(response.status).json({ error: 'TikTok API error: ' + response.status });
    }
    
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    console.error('search-tiktok error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
