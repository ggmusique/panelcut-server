import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import https from 'node:https';

const app = express();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL;
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_MODEL_FALLBACKS = [DEFAULT_CLAUDE_MODEL, 'claude-sonnet-4-6'];
const CLAUDE_TIMEOUT_MS = 20000;
const MAX_IMAGE_BASE64_LENGTH = 14 * 1024 * 1024; // ~10.5MB binaire
const MIN_IMAGE_BASE64_LENGTH = 128;
const VALID_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const MIN_DIM_CM = 1;
const MAX_DIM_CM = 500;
const MAX_THICKNESS_CM = 20;
const VALID_MODELS = new Set(CLAUDE_MODEL_FALLBACKS);

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

const toFiniteNumber = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizeError = (error) => {
  if (!error) return { message: 'unknown_error' };
  if (typeof error === 'string') return { message: error };
  return {
    message: error.message || 'unknown_error',
    code: error.code,
    status: error.status,
    detail: error.detail,
    name: error.name,
  };
};

const parsePossibleJSON = (text) => {
  if (typeof text !== 'string' || !text.trim()) return null;
  return safeJsonParse(text);
};

const getModelCandidates = () => {
  const requestedModel = String(MODEL || '').trim();
  const invalidAliases = new Set(['latest', 'claude-latest', 'claude-3-opus-latest', 'claude-3-5-sonnet-latest']);
  const candidates = [];
  if (requestedModel && !invalidAliases.has(requestedModel.toLowerCase()) && VALID_MODELS.has(requestedModel)) {
    candidates.push(requestedModel);
  } else if (requestedModel) {
    console.warn('Invalid CLAUDE_MODEL, fallback applied:', { requestedModel, fallback: DEFAULT_CLAUDE_MODEL });
  }
  for (const model of CLAUDE_MODEL_FALLBACKS) {
    if (!candidates.includes(model)) candidates.push(model);
  }
  return candidates;
};

const fetchCompat = async (url, options = {}) => {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }
  try {
    const mod = await import('node-fetch');
    if (typeof mod.default === 'function') {
      return mod.default(url, options);
    }
  } catch {}
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode || 0,
          json: async () => safeJsonParse(bodyText),
          text: async () => bodyText,
        });
      });
    });
    req.on('error', reject);
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        const abortErr = new Error('request_aborted');
        abortErr.code = 'ABORT_ERR';
        req.destroy(abortErr);
      });
    }
    if (options.body) req.write(options.body);
    req.end();
  });
};

// ───────────────────────────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { image, mediaType } = req.body;
  if (!image) return res.status(400).json({ error: 'missing_image', status: 400, detail: null });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'api_key_missing', status: 500, detail: null });
  if (typeof image !== 'string') return res.status(400).json({ error: 'invalid_image_format', status: 400, detail: 'image_must_be_string' });

  const normalizedImage = image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  if (!BASE64_RE.test(normalizedImage)) return res.status(400).json({ error: 'invalid_image_encoding', status: 400, detail: 'invalid_base64' });
  if (normalizedImage.length < MIN_IMAGE_BASE64_LENGTH) return res.status(400).json({ error: 'image_too_small', status: 400, detail: `min_base64_chars_${MIN_IMAGE_BASE64_LENGTH}` });
  if (normalizedImage.length > MAX_IMAGE_BASE64_LENGTH) return res.status(413).json({ error: 'image_too_large', status: 413, detail: `max_base64_chars_${MAX_IMAGE_BASE64_LENGTH}` });
  const effectiveMediaType = VALID_MEDIA_TYPES.has(mediaType) ? mediaType : 'image/jpeg';
  const imageSizeKb = Math.round((normalizedImage.length * 3 / 4) / 1024);
  const modelCandidates = getModelCandidates();

  console.info('SCAN DEBUG:', {
    imageSizeKb,
    mediaType: effectiveMediaType,
    models: modelCandidates,
  });

  // ─ Helper : appel Claude Vision ─────────────────────────────────────────────
  const callClaude = async (prompt, maxTokens = 2048) => {
    const tried = [];
    for (const modelName of modelCandidates) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => {
        if (controller) controller.abort();
      }, CLAUDE_TIMEOUT_MS);
      tried.push(modelName);

      try {
        const r = await fetchCompat('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          signal: controller?.signal,
          body: JSON.stringify({
            model: modelName,
            max_tokens: maxTokens,
            temperature: 0,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: effectiveMediaType, data: normalizedImage } },
                { type: 'text', text: prompt },
              ],
            }],
          }),
        });

        const raw = await r.text();
        const detail = parsePossibleJSON(raw) || raw || null;

        if (!r.ok) {
          console.error('ANTHROPIC ERROR FULL:', { status: r.status, detail, raw, model: modelName });
          const message = typeof detail === 'object' && detail?.error?.type === 'not_found_error'
            ? 'api_model_not_found'
            : 'api_error';
          const err = Object.assign(new Error(message), { status: r.status, detail, raw, model: modelName });
          throw err;
        }

        const d = parsePossibleJSON(raw);
        if (!d || typeof d !== 'object') {
          throw Object.assign(new Error('api_invalid_response'), { status: 502, detail: { reason: 'invalid_json' }, raw, model: modelName });
        }
        return d.content?.[0]?.text || '';
      } catch (error) {
        const isTimeout = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
        if (isTimeout) {
          console.error('ANTHROPIC ERROR FULL:', { status: 504, detail: 'api_timeout', raw: null, model: modelName });
          throw Object.assign(new Error('api_timeout'), { status: 504, detail: 'request_timeout', model: modelName });
        }
        if (error?.message === 'api_model_not_found' && modelName !== modelCandidates[modelCandidates.length - 1]) {
          continue;
        }
        if (error?.message === 'api_error' || error?.message === 'api_invalid_response' || error?.message === 'api_model_not_found') {
          throw error;
        }
        console.error('ANTHROPIC ERROR FULL:', { status: 502, detail: normalizeError(error), raw: null, model: modelName });
        throw Object.assign(new Error('api_network_error'), { status: 502, detail: normalizeError(error), model: modelName });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw Object.assign(new Error('api_model_fallback_exhausted'), { status: 502, detail: { tried } });
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
    const unit = cabinet.unit ?? 'cm';
    const normalizedWidth = toCm(cabinet.width, unit);
    const normalizedHeight = toCm(cabinet.height, unit);
    const normalizedDepth = toCm(cabinet.depth, unit);
    const normalizedThickness = toCm(cabinet.thickness, unit);
    const sanitizeDim = (v, fallback = null) => {
      if (v === null || v === undefined) return fallback;
      const num = toFiniteNumber(v);
      if (num === null) return fallback;
      if (num <= 0) return fallback;
      return clamp(num, MIN_DIM_CM, MAX_DIM_CM);
    };

    const cabNorm = {
      type:      cabinet.type      ?? 'autre',
      name:      cabinet.name      ?? '',
      width:     sanitizeDim(normalizedWidth, null),
      height:    sanitizeDim(normalizedHeight, null),
      depth:     sanitizeDim(normalizedDepth, 60),
      thickness: clamp(sanitizeDim(normalizedThickness, 1.8), MIN_DIM_CM, MAX_THICKNESS_CM),
      material:  cabinet.material  ?? 'inconnu',
      nb_shelves:   Math.max(0, Math.round(toFiniteNumber(cabinet.nb_shelves) ?? 0)),
      nb_doors:     Math.max(0, Math.round(toFiniteNumber(cabinet.nb_doors) ?? 0)),
      nb_drawers:   Math.max(0, Math.round(toFiniteNumber(cabinet.nb_drawers) ?? 0)),
      nb_dividers:  Math.max(0, Math.round(toFiniteNumber(cabinet.nb_dividers) ?? 0)),
      confidence:   clamp(toFiniteNumber(cabinet.confidence) ?? 0.5, 0, 1),
      scale_note:   cabinet.scale_note   ?? '',
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
      return res.status(422).json({ error: 'no_pieces', status: 422, detail: raw2 });
    }

    // ─ Nettoyage + validation des pièces ──────────────────────────────────────────
    const VALID_ROLES = ['side','top','bottom','shelf','divider','back','door','drawer_front','drawer_box','other'];
    const pieces = result2.pieces
      .filter((p) => p && typeof p === 'object')
      .map(p => {
        const len = Math.abs(toFiniteNumber(p.length) ?? 0);
        const hgt = Math.abs(toFiniteNumber(p.height) ?? 0);
        if (len <= 0 || hgt <= 0) return null;
        const normalizedLength = clamp(Math.max(len, hgt), MIN_DIM_CM, MAX_DIM_CM);
        const normalizedHeight = clamp(Math.min(len, hgt), MIN_DIM_CM, MAX_DIM_CM);
        const thickness = Math.abs(toFiniteNumber(p.thickness) ?? cabNorm.thickness ?? 1.8);
        const normalizedThickness = clamp(thickness, MIN_DIM_CM, MAX_THICKNESS_CM);
        return {
          name:      String(p.name ?? 'Pièce').slice(0, 60),
          role:      VALID_ROLES.includes(p.role) ? p.role : 'other',
          length:    normalizedLength,
          height:    normalizedHeight,
          thickness: normalizedThickness,
          qty:       Math.max(0, Math.round(toFiniteNumber(p.qty) ?? 0)),
          material:  String(p.material ?? cabNorm.material ?? 'inconnu').slice(0, 30),
          notes:     String(p.notes ?? '').slice(0, 100),
        };
      })
      .filter(Boolean)
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
    const normalized = normalizeError(err);
    console.error('Scan error:', {
      message: normalized.message,
      code: normalized.code,
      status: normalized.status,
      detail: normalized.detail,
    });
    if (err.message === 'api_error' || err.message === 'api_timeout' || err.message === 'api_network_error' || err.message === 'api_invalid_response') {
      const status = Number.isInteger(err.status) ? err.status : 502;
      return res.status(status).json({ error: 'api_error', status, detail: err.detail });
    }
    if (err.message === 'api_model_fallback_exhausted' || err.message === 'api_model_not_found') {
      const status = Number.isInteger(err.status) ? err.status : 502;
      return res.status(status).json({ error: err.message, status, detail: err.detail });
    }
    res.status(500).json({ error: 'server_error', status: 500, detail: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// buildCabinetPanels : reconstitue les positions x,y de chaque panneau
// ───────────────────────────────────────────────────────────────────────────
function buildCabinetPanels(pieces, cab) {
  if (!cab.width || !cab.height) return [];
  const T = cab.thickness ?? 1.8;
  const W = cab.width, H = cab.height;
  const panels = [];

  let shelfIdx = 0, divIdx = 0, doorIdx = 0, drawerIdx = 0;

  for (const p of pieces) {
    const qty = p.qty ?? 0;
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
          const totalShelves = cab.nb_shelves ?? 0;
          const usableH = H - 2 * T;
          const gap = usableH / ((totalShelves > 0 ? totalShelves : 1) + 1);
          panel.x = T;
          panel.y = T + gap * (shelfIdx + 1);
          panel.w = W - 2 * T; panel.h = T;
          shelfIdx++;
          break;
        }

        case 'divider': {
          const totalDiv = cab.nb_dividers ?? 0;
          const usableW = W - 2 * T;
          const gap = usableW / ((totalDiv > 0 ? totalDiv : 1) + 1);
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
          const totalDoors = cab.nb_doors ?? 0;
          const doorW = (W - 2 * T) / (totalDoors > 0 ? totalDoors : 1);
          panel.x = T + doorW * doorIdx;
          panel.y = T;
          panel.w = doorW; panel.h = H - 2 * T;
          doorIdx++;
          break;
        }

        case 'drawer_front': {
          const totalDrawers = cab.nb_drawers ?? 0;
          const drawerH = (H - 2 * T) / (totalDrawers > 0 ? totalDrawers : 1);
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
  res.status(500).json({ error: 'server_error', status: 500, detail: err.message || null });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PanelCut server on port ${PORT}`));
