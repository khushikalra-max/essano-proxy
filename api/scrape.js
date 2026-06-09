// api/scrape.js — deploy to Vercel as a serverless function
// Proxies Apify scraper calls server-side to avoid browser CORS restrictions

export default async function handler(req, res) {
  // Allow requests from claude.ai artifacts
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    // 1. Start the actor run
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inputBody) }
    );
    if (!startRes.ok) {
      const err = await startRes.text();
      return res.status(500).json({ error: `Apify start failed: ${startRes.status} — ${err}` });
    }
    const { data: { id: runId } } = await startRes.json();

    // 2. Poll until succeeded (max 90s)
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const pollRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyKey}`);
      const { data: { status } } = await pollRes.json();
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') {
        return res.status(500).json({ error: `Apify run ${status.toLowerCase()}` });
      }
    }

    // 3. Fetch dataset items
    const dataRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyKey}&limit=12`
    );
    const items = await dataRes.json();

    // 4. Normalise into a consistent shape
    const normalised = items.map((x, i) => ({
      id: i,
      title: (platform === 'tiktok' ? x.text : x.caption || '')?.slice(0, 80) || `Post ${i + 1}`,
      views: platform === 'tiktok' ? (x.playCount || 0) : (x.likesCount || 0),
      likes: platform === 'tiktok' ? (x.diggCount || 0) : (x.commentsCount || 0),
      hashtags: platform === 'tiktok'
        ? (x.hashtags || []).slice(0, 5).map(h => '#' + h.name)
        : ((platform === 'instagram' ? x.caption : '') || '').match(/#\w+/g)?.slice(0, 5) || [],
      summary: (platform === 'tiktok' ? x.text : x.caption || '')?.slice(0, 300) || '',
      platform,
    }));

    return res.status(200).json({ results: normalised });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
