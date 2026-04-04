import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.includes('netlify.app') || origin.includes('localhost') || origin.includes('panelcut')) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '15mb' }));

app.use('/scan', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'too_many_requests' },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ───────────────────────────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { image, mediaType } = req.body;
  if (!image)             return res.status(400).json({ error: 'missing_image' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'api_key_missing' });

  // ─ Helper : appel Claude Vision ─────────────────────────────────────────────
  const callClaude = async (prompt, maxTokens = 2048) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20241022', // Version stable recommandée
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw Object.assign(new Error('api_error'), { status: r.status, detail: e });
    }
    const d = await r.json();
    return d.content?.[0]?.text || '';
  };

  // ─ Parse JSON robuste ────────────────────────────────────────────────────────
  const parseJSON = (text) => {
    const clean = text.replace(/```json|```/g, '').trim();
    try { return JSON.parse(clean); } catch {}
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    return null;
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // PASSE 1 — Lecture globale du meuble
    // ═══════════════════════════════════════════════════════════════════════
    const pass1prompt = `Tu es un expert en lecture de plans de menuiserie.

ANALYSE CE PLAN et retourne UNIQUEMENT un JSON valide (aucun texte avant/après).

OBJECTIF PASSE 1 : Comprendre la structure globale du meuble.

JSON à retourner :
{
  "type": "armoire" | "bibliotheque" | "cuisine" | "bureau" | "commode" | "autre",
  "name": "nom du meuble si visible sur le plan",
  "width":  <largeur totale extérieure en cm>,
  "height": <hauteur totale extérieure en cm>,
  "depth":  <profondeur en cm, défaut 60>,
  "thickness": <épaisseur des panneaux en cm, défaut 1.8>,
  "material": "melamine" | "contreplaque" | "mdf" | "bois_massif" | "inconnu",
  "unit": "cm" | "mm" | "m",
  "nb_shelves": <nombre de tablettes>,
  "nb_doors": <nombre de portes>,
  "nb_drawers": <nombre de tiroirs>,
  "nb_dividers": <nombre de séparations verticales>,
  "confidence": <0.0 à 1.0>
}

Si une valeur n'est pas visible, utilise null sauf pour depth/thickness où tu mets les valeurs standard.`;

    const raw1 = await callClaude(pass1prompt, 1024);
    const cabinet = parseJSON(raw1) || {};

    // Normalise l'unité — convertit tout en cm
    const toCm = (v, unit) => {
      if (v === null || v === undefined) return null;
      if (unit === 'mm') return v / 10;
      if (unit === 'm')  return v * 100;
      return v;
    };
    const unit = cabinet.unit || 'cm';
    const cabNorm = {
      type:      cabinet.type      || 'autre',
      name:      cabinet.name      || '',
      width:     toCm(cabinet.width,     unit),
      height:    toCm(cabinet.height,    unit),
      depth:     toCm(cabinet.depth,     unit) || 60,
      thickness: toCm(cabinet.thickness, unit) || 1.8,
      material:  cabinet.material  || 'inconnu',
      nb_shelves:   cabinet.nb_shelves   || 0,
      nb_doors:     cabinet.nb_doors     || 0,
      nb_drawers:   cabinet.nb_drawers   || 0,
      nb_dividers:  cabinet.nb_dividers  || 0,
      confidence:   cabinet.confidence   || 0.5,
      scale_note:   cabinet.scale_note   || '',
    };

    // ═══════════════════════════════════════════════════════════════════════
    // PASSE 2 — Extraction exhaustive de toutes les pièces
    // ═══════════════════════════════════════════════════════════════════════
    const context = cabNorm.width
      ? `CONTEXTE PASSE 1 : meuble ${cabNorm.type}, dimensions ext: ${cabNorm.width}×${cabNorm.height}×${cabNorm.depth} cm, épaisseur ${cabNorm.thickness} cm.`
      : '';

    const pass2prompt = `Tu es un expert menuisier CAO.
${context}

ANALYSE CE PLAN et retourne UNIQUEMENT un JSON valide (aucun texte avant/après).

OBJECTIF PASSE 2 : Extraire CHAQUE pièce individuelle avec ses dimensions exactes.

RÔLES POSSIBLES : "side", "top", "bottom", "shelf", "divider", "back", "door", "drawer_front", "drawer_box", "other".

FORMAT EXACT :
{
  "pieces": [
    {
      "name": "Côté gauche",
      "role": "side",
      "length": 210.0,
      "height": 60.0,
      "thickness": 1.8,
      "qty": 2,
      "material": "melamine",
      "notes": "avec évidement poignée" 
    }
  ]
}

RÈGLES STRICTES :
1. Extrais TOUTES les pièces.
2. "length" = plus grande dimension planaire (cm).
3. "height" = deuxième dimension planaire (cm).
4. "thickness" = épaisseur (cm).
5. "qty" : cherche x2, ×2, (2), symétrie.
6. Convertis TOUTES les dimensions en cm.
7. Ne jamais retourner length=0 ou height=0.`;

    const raw2 = await callClaude(pass2prompt, 2048);
    const result2 = parseJSON(raw2);

    if (!result2?.pieces?.length) {
      return res.status(422).json({ error: 'no_pieces', raw: raw2 });
    }

    // ─ Nettoyage + validation des pièces ──────────────────────────────────────────
    const VALID_ROLES = ['side','top','bottom','shelf','divider','back','door','drawer_front','drawer_box','other'];
    const pieces = result2.pieces
      .filter(p => p.length > 0 && p.height > 0)
      .map(p => {
        const len = Math.abs(parseFloat(p.length) || 0);
        const hgt = Math.abs(parseFloat(p.height) || 0);
        return {
          name:      String(p.name || 'Pièce').slice(0, 60),
          role:      VALID_ROLES.includes(p.role) ? p.role : 'other',
          length:    Math.max(len, hgt),
          height:    Math.min(len, hgt),
          thickness: Math.abs(parseFloat(p.thickness) || cabNorm.thickness || 1.8),
          qty:       Math.max(1, Math.round(parseFloat(p.qty) || 1)),
          material:  String(p.material || cabNorm.material || 'inconnu').slice(0, 30),
          notes:     String(p.notes || '').slice(0, 100),
        };
      })
      .filter(p => p.length > 0 && p.height > 0);

    // ─ Génère les panneaux structurels pour la vue 3D ─────────────────────────
    const cabinetPanels = buildCabinetPanels(pieces, cabNorm);

    res.json({
      pieces,
      cabinet: { ...cabNorm, panels: cabinetPanels },
      raw1,
      raw2,
    });

  } catch (err) {
    console.error('Scan error:', err.message, err.detail || '');
    if (err.message === 'api_error') {
      return res.status(502).json({ error: 'api_error', status: err.status, detail: err.detail });
    }
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// buildCabinetPanels : reconstitue les positions x,y de chaque panneau
// ───────────────────────────────────────────────────────────────────────────
function buildCabinetPanels(pieces, cab) {
  if (!cab.width || !cab.height) return [];
  const T = cab.thickness || 1.8;
  const W = cab.width, H = cab.height;
  const panels = [];

  let shelfIdx = 0, divIdx = 0, doorIdx = 0, drawerIdx = 0;

  for (const p of pieces) {
    const qty = p.qty || 1;
    const l = p.length, h = p.height;

    for (let q = 0; q < qty; q++) {
      let panel = { role: p.role, w: l, h, name: p.name };

      switch (p.role) {
        case 'side':
          panel.x = q === 0 ? 0 : W - T;
          panel.y = 0;
          panel.w = T; panel.h = h;
          break;

        case 'top':
          panel.x = T; panel.y = H - T;
          panel.w = W - 2 * T; panel.h = T;
          break;

        case 'bottom':
          panel.x = T; panel.y = 0;
          panel.w = W - 2 * T; panel.h = T;
          break;

        case 'shelf': {
          const totalShelves = cab.nb_shelves || 1;
          const usableH = H - 2 * T;
          const gap = usableH / (totalShelves + 1);
          panel.x = T;
          panel.y = T + gap * (shelfIdx + 1);
          panel.w = W - 2 * T; panel.h = T;
          shelfIdx++;
          break;
        }

        case 'divider': {
          const totalDiv = cab.nb_dividers || 1;
          const usableW = W - 2 * T;
          const gap = usableW / (totalDiv + 1);
          panel.x = T + gap * (divIdx + 1);
          panel.y = T;
          panel.w = T; panel.h = H - 2 * T;
          divIdx++;
          break;
        }

        case 'back':
          panel.x = T; panel.y = T;
          panel.w = W - 2 * T; panel.h = H - 2 * T;
          break;

        case 'door': {
          const totalDoors = cab.nb_doors || 1;
          const doorW = (W - 2 * T) / totalDoors;
          panel.x = T + doorW * doorIdx;
          panel.y = T;
          panel.w = doorW; panel.h = H - 2 * T;
          doorIdx++;
          break;
        }

        case 'drawer_front': {
          const totalDrawers = cab.nb_drawers || 1;
          const drawerH = (H - 2 * T) / totalDrawers;
          panel.x = T;
          panel.y = T + drawerH * drawerIdx;
          panel.w = W - 2 * T; panel.h = drawerH;
          drawerIdx++;
          break;
        }

        default:
          panel.x = T; panel.y = T;
          panel.w = l; panel.h = h;
      }

      panels.push(panel);
    }
  }

  return panels;
}

app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PanelCut server on port ${PORT}`));
