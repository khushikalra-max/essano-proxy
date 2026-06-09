module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  // ── COPY GENERATION ──────────────────────────────────────────────
  if (action === 'generate') {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(500).json({ error: `Anthropic error (${r.status}): ${txt}` });
      }
      const data = await r.json();
      return res.status(200).json({ text: data.content?.[0]?.text || '' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── APIFY SCRAPE ─────────────────────────────────────────────────
  if (action === 'scrape') {
    const { apifyKey, platform, hashtag } = req.body;
    if (!apifyKey || !platform || !hashtag) {
      return res.status(400).json({ error: 'Missing apifyKey, platform, or hashtag' });
    }

    const clean = hashtag.replace(/^#/, '');
    const actorId = platform === 'tiktok'
      ? 'clockworks~free-tiktok-scraper'
      : 'apify~instagram-hashtag-scraper';
    const inputBody = platform === 'tiktok'
      ? { hashtags: [clean], resultsPerPage: 10, shouldDownloadVideos: false, shouldDownloadCovers: false }
      : { hashtags: [clean], resultsLimit: 10 };

    try {
      const startRes = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inputBody) }
      );
      if (!startRes.ok) {
        const txt = await startRes.text();
        return res.status(500).json({ error: `Apify start failed (${startRes.status}): ${txt}` });
      }
      const startData = await startRes.json();
      const runId = startData.data.id;

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyKey}`);
        const pollData = await pollRes.json();
        const status = pollData.data.status;
        if (status === 'SUCCEEDED') break;
        if (status === 'FAILED' || status === 'ABORTED') {
          return res.status(500).json({ error: `Apify run ${status.toLowerCase()}` });
        }
      }

      const dataRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyKey}&limit=12`
      );
      const items = await dataRes.json();

      const results = items.map((x, i) => ({
        id: i,
        title: (platform === 'tiktok' ? (x.text || '') : (x.caption || '')).slice(0, 80) || `Post ${i + 1}`,
        views: platform === 'tiktok' ? (x.playCount || 0) : (x.likesCount || 0),
        likes: platform === 'tiktok' ? (x.diggCount || 0) : (x.commentsCount || 0),
        hashtags: platform === 'tiktok'
          ? (x.hashtags || []).slice(0, 5).map(h => '#' + h.name)
          : ((x.caption || '').match(/#\w+/g) || []).slice(0, 5),
        summary: (platform === 'tiktok' ? (x.text || '') : (x.caption || '')).slice(0, 300),
        platform,
      }));

      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Missing or invalid action. Use "scrape" or "generate".' });
};
