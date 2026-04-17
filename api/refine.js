/**
 * api/refine.js — Relance Claude Vision sur un croquis annoté
 */

const REFINE_SYSTEM = `Tu es un expert menuisier-ébéniste et dessinateur industriel.
Tu analyses un croquis de meuble ANNOTÉ avec des corrections de l'utilisateur.

RETOURNE UNIQUEMENT ce JSON valide, sans backticks, sans texte autour :

{
  "pieces": [
    {"name": "Montant G", "length": 226.4, "height": 58, "qty": 2, "role": "side"}
  ],
  "cabinet": {
    "type": "armoire",
    "width": 120,
    "height": 220,
    "depth": 58,
    "thickness": 1.8,
    "plinth": 8,
    "nb_shelves": 3,
    "nb_doors": 2,
    "nb_drawers": 0,
    "nb_dividers": 1,
    "modules": [],
    "panels": []
  },
  "confidence": 0.92,
  "corrections_applied": ["Hauteur corrigée à 220 cm"]
}

RÈGLES :
- dimensions en cm
- Si une annotation indique une cote, utilise-la EXACTEMENT
- confidence entre 0.0 et 1.0`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age',       '86400');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method_not_allowed' });

  const { image, mediaType, prompt, context } = req.body;
  if (!image) return res.status(400).json({ error: 'missing_image' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'api_key_missing' });

  const contextSummary = context?.cabinet?.width
    ? `Scan initial : ${context.cabinet.width}×${context.cabinet.height}×${context.cabinet.depth ?? '?'} cm.`
    : '';

  const userText = [
    'Voici le croquis ANNOTÉ avec les corrections de l\'utilisateur.',
    contextSummary,
    prompt || 'Analyse les annotations et retourne le JSON corrigé.',
    'Retourne le JSON uniquement, sans texte autour.',
  ].filter(Boolean).join('\n\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system:     REFINE_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: image } },
            { type: 'text',  text: userText },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(500).json({ error: 'api_error', detail: err });
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
      .filter(p => p.length > 0 && p.height > 0)
      .map(p => ({
        name:   String(p.name || 'Pièce').slice(0, 50),
        length: Math.abs(parseFloat(p.length) || 0),
        height: Math.abs(parseFloat(p.height) || 0),
        qty:    Math.max(1, Math.round(parseFloat(p.qty) || 1)),
        role:   p.role || 'other',
      }))
      .filter(p => p.length > 0 && p.height > 0);

    const rawCab = parsed.cabinet || {};
    const cabinet = {
      type:        rawCab.type        || 'autre',
      width:       parseFloat(rawCab.width)       || 0,
      height:      parseFloat(rawCab.height)      || 0,
      depth:       parseFloat(rawCab.depth)       || 60,
      thickness:   parseFloat(rawCab.thickness)   || 1.8,
      plinth:      parseFloat(rawCab.plinth)      || 0,
      nb_shelves:  parseInt(rawCab.nb_shelves)    || 0,
      nb_doors:    parseInt(rawCab.nb_doors)      || 0,
      nb_drawers:  parseInt(rawCab.nb_drawers)    || 0,
      nb_dividers: parseInt(rawCab.nb_dividers)   || 0,
      modules:     Array.isArray(rawCab.modules)  ? rawCab.modules : [],
      panels:      Array.isArray(rawCab.panels)   ? rawCab.panels.map(p => ({
        role: p.role || 'side',
        name: String(p.name || '').slice(0, 40),
        w:    parseFloat(p.w) || 0,
        h:    parseFloat(p.h) || 0,
        qty:  Math.max(1, parseInt(p.qty) || 1),
        x:    parseFloat(p.x) || 0,
        y:    parseFloat(p.y) || 0,
        z:    parseFloat(p.z) || 0,
      })) : [],
    };

    res.json({
      pieces,
      cabinet,
      confidence:          parsed.confidence          || null,
      corrections_applied: parsed.corrections_applied || [],
    });

  } catch (err) {
    console.error('Refine error:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
}
