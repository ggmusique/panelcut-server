export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { image, mediaType } = req.body;
  if (!image) return res.status(400).json({ error: 'missing_image' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'api_key_missing' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: `Expert menuisier. Analyse ce plan de meuble.
Retourne UNIQUEMENT ce JSON (sans backticks) :
{"pieces":[{"name":"Montant G","length":220,"height":58,"qty":2}],"cabinet":{"type":"armoire","width":120,"height":220,"depth":58,"thickness":1.8,"plinth":8,"modules":[{"x":0,"width":60,"shelves":2,"doors":1,"drawers":0}],"panels":[{"role":"side","name":"C\u00f4t\u00e9 G","w":58,"h":220,"qty":1,"x":0,"y":0,"z":0}]}}
R\u00e8gles: dimensions en cm, length=grande dim, height=petite dim, qty r\u00e9el. Types: armoire|biblioth\u00e8que|cuisine|buffet|meuble-tv|dressing|autre. Roles: side|back|top|bottom|shelf|divider|door|drawer_front. Mets 0 si illisible.` }
          ]
        }]
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('Anthropic error', response.status, errBody);
      return res.status(500).json({ error: 'api_error', status: response.status, detail: errBody });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    let parsed;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      const match = clean.match(/{[\s\S]*}/);
      parsed = JSON.parse(match ? match[0] : clean);
    } catch {
      return res.status(422).json({ error: 'parse_error', raw: text });
    }

    const pieces = (parsed.pieces || [])
      .map(p => ({
        name:   String(p.name || 'Pi\u00e8ce').slice(0, 50),
        length: Math.abs(parseFloat(p.length) || 0),
        height: Math.abs(parseFloat(p.height) || 0),
        qty:    Math.max(1, Math.round(parseFloat(p.qty) || 1)),
      }))
      .filter(p => p.length > 0 && p.height > 0);

    const rawCab = parsed.cabinet || {};
    const cabinet = {
      type:      rawCab.type      || 'autre',
      width:     parseFloat(rawCab.width)     || 0,
      height:    parseFloat(rawCab.height)    || 0,
      depth:     parseFloat(rawCab.depth)     || 60,
      thickness: parseFloat(rawCab.thickness) || 1.8,
      plinth:    parseFloat(rawCab.plinth)    || 0,
      modules:   Array.isArray(rawCab.modules) ? rawCab.modules : [],
      panels:    Array.isArray(rawCab.panels) ? rawCab.panels.map(p => ({
        role: p.role || 'side',
        name: String(p.name || '').slice(0, 40),
        w: parseFloat(p.w) || 0,
        h: parseFloat(p.h) || 0,
        qty: Math.max(1, parseInt(p.qty) || 1),
        x: parseFloat(p.x) || 0,
        y: parseFloat(p.y) || 0,
        z: parseFloat(p.z) || 0,
      })) : [],
    };

    res.json({ pieces, cabinet });

  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = err.name === 'AbortError';
    console.error('Scan error:', err.message);
    res.status(500).json({ error: isTimeout ? 'timeout' : 'server_error', message: err.message });
  }
}
