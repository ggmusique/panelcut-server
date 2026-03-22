import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── CORS ──────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Autorise l'app React (Netlify) + localhost dev
    if (!origin || origin.includes('netlify.app') || origin.includes('localhost')) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '10mb' })); // images base64 peuvent être grandes

// ── Rate limiting ─────────────────────────────────────────────────────────
app.use('/scan', rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 20,                   // 20 scans max par IP par heure
  message: { error: 'too_many_requests' }
}));

// ── Healthcheck ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── POST /scan ────────────────────────────────────────────────────────────
// Body: { image: "base64string", mediaType: "image/jpeg" }
// Retourne: { pieces: [{name, length, height, qty}] }
app.post('/scan', async (req, res) => {
  const { image, mediaType } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'missing_image' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'api_key_missing' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: image,
                }
              },
              {
                type: 'text',
                text: `Tu es un expert menuisier. Analyse ce plan de découpe et extrait toutes les pièces avec leurs dimensions.

RÈGLES STRICTES :
- Retourne UNIQUEMENT un JSON valide, rien d'autre
- Pas de texte avant ou après le JSON
- Pas de backticks, pas de markdown
- Si tu ne vois pas de dimensions claires, retourne {"pieces": [], "error": "no_dimensions"}

FORMAT EXACT à retourner :
{
  "pieces": [
    {"name": "Montant", "length": 226.4, "height": 58, "qty": 4},
    {"name": "Tablette", "length": 75.6, "height": 58, "qty": 2}
  ]
}

COMMENT LIRE LES PLANS :
- Les dimensions sont en cm généralement
- "qty" = nombre de pièces identiques (cherche les annotations comme "x4", "4P", "(4)", "×4")
- Si pas de quantité indiquée, mets 1
- Le nom = type de pièce (montant, tablette, étagère, traverse, dos, fond, côté...)
- Si le nom n'est pas clair, utilise "Pièce 1", "Pièce 2", etc.
- Longueur = la plus grande dimension
- Hauteur = la plus petite dimension

Extrait TOUTES les pièces visibles sur ce plan.`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, err);
      return res.status(500).json({ error: 'api_error', detail: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse le JSON retourné par Claude
    let parsed;
    try {
      // Nettoie au cas où Claude aurait quand même mis des backticks
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse error:', text);
      return res.status(422).json({ error: 'parse_error', raw: text });
    }

    // Valide et nettoie les pièces
    const pieces = (parsed.pieces || [])
      .filter(p => p.length > 0 && p.height > 0)
      .map(p => ({
        name:   String(p.name || 'Pièce').slice(0, 50),
        length: Math.abs(parseFloat(p.length) || 0),
        height: Math.abs(parseFloat(p.height) || 0),
        qty:    Math.max(1, Math.round(parseFloat(p.qty) || 1)),
      }))
      .filter(p => p.length > 0 && p.height > 0);

    res.json({ pieces, raw: text });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Middleware erreur global ──────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'server_error' });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PanelCut server on port ${PORT}`));
