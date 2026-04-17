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
        role: p.role || 'side',/**
 * api/scan.js — Vercel Serverless Function
 * Adapté depuis le serveur Express standalone.
 * Déployable directement dans le dossier /api du repo.
 */

import https from 'node:https';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Modèles valides — mettre à jour ici quand Anthropic sort de nouveaux modèles
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MODEL_FALLBACKS = ['claude-sonnet-4-6', 'claude-opus-4-6'];

const CLAUDE_TIMEOUT_MS = 25000;
const MAX_IMAGE_BASE64_LENGTH = 14 * 1024 * 1024;
const MIN_IMAGE_BASE64_LENGTH = 128;
const VALID_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const MIN_DIM_CM = 1;
const MAX_DIM_CM = 500;
const MAX_THICKNESS_CM = 20;

// ─── Helpers ────────────────────────────────────────────────────────────────

const toFiniteNumber = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const safeJsonParse = (t) => { try { return JSON.parse(t); } catch { return null; } };

const normalizeError = (error) => {
  if (!error) return { message: 'unknown_error' };
  if (typeof error === 'string') return { message: error };
  return { message: error.message || 'unknown_error', code: error.code, status: error.status };
};

const parseJSON = (text) => {
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
};

const toCm = (v, unit) => {
  if (v === null || v === undefined) return null;
  if (unit === 'mm') return v / 10;
  if (unit === 'm') return v * 100;
  return v;
};

const sanitizeDim = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  const num = toFiniteNumber(v);
  if (num === null || num <= 0) return fallback;
  return clamp(num, MIN_DIM_CM, MAX_DIM_CM);
};

// ─── Appel Anthropic avec fallback de modèles ──────────────────────────────

const callClaude = async (imageBase64, mediaType, prompt, maxTokens = 2048) => {
  // Résolution du modèle : variable d'env > fallback
  const envModel = String(process.env.CLAUDE_MODEL || '').trim();
  const candidates = envModel && MODEL_FALLBACKS.includes(envModel)
    ? [envModel, ...MODEL_FALLBACKS.filter(m => m !== envModel)]
    : [DEFAULT_MODEL, ...MODEL_FALLBACKS.filter(m => m !== DEFAULT_MODEL)];

  const tried = [];

  for (const modelName of candidates) {
    tried.push(modelName);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), CLAUDE_TIMEOUT_MS);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
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
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });

      clearTimeout(timeout);
      const raw = await response.text();
      const data = safeJsonParse(raw);

      if (!response.ok) {
        const errorType = data?.error?.type;
        // Modèle introuvable → essayer le suivant
        if (errorType === 'not_found_error' && tried.length < candidates.length) {
          console.warn(`Model ${modelName} not found, trying next...`);
          continue;
        }
        const err = Object.assign(new Error('api_error'), {
          status: response.status,
          detail: data,
          model: modelName,
        });
        throw err;
      }

      if (!data || typeof data !== 'object') {
        throw Object.assign(new Error('api_invalid_response'), { status: 502, model: modelName });
      }

      return data.content?.[0]?.text || '';

    } catch (error) {
      clearTimeout(timeout);
      const isAbort = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
      if (isAbort) throw Object.assign(new Error('api_timeout'), { status: 504 });
      // Si c'est une erreur API propagée (pas un not_found), on remonte immédiatement
      if (error?.message === 'api_error' || error?.message === 'api_invalid_response') throw error;
      throw Object.assign(new Error('api_network_error'), { status: 502, detail: normalizeError(error) });
    }
  }

  throw Object.assign(new Error('api_model_fallback_exhausted'), { status: 502, detail: { tried } });
};

// ─── Construction des panneaux pour la vue 3D ─────────────────────────────

function buildCabinetPanels(pieces, cab) {
  if (!cab.width || !cab.height) return [];
  const T = cab.thickness ?? 1.8;
  const W = cab.width, H = cab.height;
  const panels = [];
  let shelfIdx = 0, divIdx = 0, doorIdx = 0, drawerIdx = 0;

  for (const p of pieces) {
    const qty = p.qty ?? 0;
    for (let q = 0; q < qty; q++) {
      let panel = { role: p.role, w: p.length, h: p.height, name: p.name };
      switch (p.role) {
        case 'side':
          panel.x = q === 0 ? 0 : W - T;
          panel.y = 0; panel.w = T; panel.h = H;
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
          const total = cab.nb_shelves || 1;
          const gap = (H - 2 * T) / (total + 1);
          panel.x = T; panel.y = T + gap * (shelfIdx + 1);
          panel.w = W - 2 * T; panel.h = T;
          shelfIdx++;
          break;
        }
        case 'divider': {
          const total = cab.nb_dividers || 1;
          const gap = (W - 2 * T) / (total + 1);
          panel.x = T + gap * (divIdx + 1); panel.y = T;
          panel.w = T; panel.h = H - 2 * T;
          divIdx++;
          break;
        }
        case 'back':
          panel.x = T; panel.y = T;
          panel.w = W - 2 * T; panel.h = H - 2 * T;
          break;
        case 'door': {
          const total = cab.nb_doors || 1;
          const doorW = (W - 2 * T) / total;
          panel.x = T + doorW * doorIdx; panel.y = T;
          panel.w = doorW; panel.h = H - 2 * T;
          doorIdx++;
          break;
        }
        case 'drawer_front': {
          const total = cab.nb_drawers || 1;
          const drawerH = (H - 2 * T) / total;
          panel.x = T; panel.y = T + drawerH * drawerIdx;
          panel.w = W - 2 * T; panel.h = drawerH;
          drawerIdx++;
          break;
        }
        default:
          panel.x = T; panel.y = T;
      }
      panels.push(panel);
    }
  }
  return panels;
}

// ─── Handler principal Vercel ──────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'api_key_missing', detail: 'ANTHROPIC_API_KEY not set in Vercel env vars' });
  }

  const { image, mediaType } = req.body || {};

  if (!image) return res.status(400).json({ error: 'missing_image' });
  if (typeof image !== 'string') return res.status(400).json({ error: 'invalid_image_format' });

  const normalizedImage = image
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s/g, '');

  if (!BASE64_RE.test(normalizedImage))
    return res.status(400).json({ error: 'invalid_image_encoding' });
  if (normalizedImage.length < MIN_IMAGE_BASE64_LENGTH)
    return res.status(400).json({ error: 'image_too_small' });
  if (normalizedImage.length > MAX_IMAGE_BASE64_LENGTH)
    return res.status(413).json({ error: 'image_too_large' });

  const effectiveMediaType = VALID_MEDIA_TYPES.has(mediaType) ? mediaType : 'image/jpeg';

  console.info('SCAN:', {
    sizekb: Math.round((normalizedImage.length * 3 / 4) / 1024),
    mediaType: effectiveMediaType,
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
  });

  try {
    // ── Passe 1 : structure globale ──────────────────────────────────────
    const pass1prompt = `Tu es un expert en lecture de plans de menuiserie.

ANALYSE CE PLAN et retourne UNIQUEMENT un JSON valide (aucun texte avant/après).

JSON à retourner :
{
  "type": "armoire" | "bibliotheque" | "cuisine" | "bureau" | "commode" | "autre",
  "name": "nom du meuble si visible",
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

Si une valeur n'est pas visible, utilise null sauf depth/thickness où tu utilises les valeurs standard.`;

    const raw1 = await callClaude(normalizedImage, effectiveMediaType, pass1prompt, 1024);
    const cabinet = parseJSON(raw1) || {};

    const unit = cabinet.unit ?? 'cm';
    const cabNorm = {
      type:        cabinet.type      ?? 'autre',
      name:        cabinet.name      ?? '',
      width:       sanitizeDim(toCm(cabinet.width,     unit), null),
      height:      sanitizeDim(toCm(cabinet.height,    unit), null),
      depth:       sanitizeDim(toCm(cabinet.depth,     unit), 60),
      thickness:   clamp(sanitizeDim(toCm(cabinet.thickness, unit), 1.8), MIN_DIM_CM, MAX_THICKNESS_CM),
      material:    cabinet.material  ?? 'inconnu',
      nb_shelves:  Math.max(0, Math.round(toFiniteNumber(cabinet.nb_shelves)  ?? 0)),
      nb_doors:    Math.max(0, Math.round(toFiniteNumber(cabinet.nb_doors)    ?? 0)),
      nb_drawers:  Math.max(0, Math.round(toFiniteNumber(cabinet.nb_drawers)  ?? 0)),
      nb_dividers: Math.max(0, Math.round(toFiniteNumber(cabinet.nb_dividers) ?? 0)),
      confidence:  clamp(toFiniteNumber(cabinet.confidence) ?? 0.5, 0, 1),
    };

    // ── Passe 2 : extraction exhaustive des pièces ───────────────────────
    const ctx = cabNorm.width
      ? `CONTEXTE PASSE 1 : meuble ${cabNorm.type}, dimensions ext: ${cabNorm.width}×${cabNorm.height}×${cabNorm.depth} cm, épaisseur ${cabNorm.thickness} cm.`
      : '';

    const pass2prompt = `Tu es un expert menuisier CAO.
${ctx}

ANALYSE CE PLAN et retourne UNIQUEMENT un JSON valide (aucun texte avant/après).

OBJECTIF : Extraire CHAQUE pièce individuelle avec ses dimensions exactes.

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
      "notes": ""
    }
  ]
}

RÈGLES :
1. Extrais TOUTES les pièces visibles.
2. "length" = plus grande dimension planaire en cm.
3. "height" = deuxième dimension planaire en cm.
4. "qty" : cherche x2, ×2, (2), ou symétrie.
5. Convertis TOUT en cm. Ne jamais retourner length=0 ou height=0.`;

    const raw2 = await callClaude(normalizedImage, effectiveMediaType, pass2prompt, 2048);
    const result2 = parseJSON(raw2);

    if (!result2?.pieces?.length) {
      return res.status(422).json({ error: 'no_pieces', detail: raw2 });
    }

    const VALID_ROLES = ['side','top','bottom','shelf','divider','back','door','drawer_front','drawer_box','other'];
    const pieces = result2.pieces
      .filter(p => p && typeof p === 'object')
      .map(p => {
        const len = Math.abs(toFiniteNumber(p.length) ?? 0);
        const hgt = Math.abs(toFiniteNumber(p.height) ?? 0);
        if (len <= 0 || hgt <= 0) return null;
        const thickness = clamp(Math.abs(toFiniteNumber(p.thickness) ?? cabNorm.thickness), MIN_DIM_CM, MAX_THICKNESS_CM);
        return {
          name:      String(p.name ?? 'Pièce').slice(0, 60),
          role:      VALID_ROLES.includes(p.role) ? p.role : 'other',
          length:    clamp(Math.max(len, hgt), MIN_DIM_CM, MAX_DIM_CM),
          height:    clamp(Math.min(len, hgt), MIN_DIM_CM, MAX_DIM_CM),
          thickness,
          qty:       Math.max(0, Math.round(toFiniteNumber(p.qty) ?? 0)),
          material:  String(p.material ?? cabNorm.material ?? 'inconnu').slice(0, 30),
          notes:     String(p.notes ?? '').slice(0, 100),
        };
      })
      .filter(p => p && p.length > 0 && p.height > 0);

    const cabinetPanels = buildCabinetPanels(pieces, cabNorm);

    return res.status(200).json({
      pieces,
      cabinet: { ...cabNorm, panels: cabinetPanels },
    });

  } catch (err) {
    const normalized = normalizeError(err);
    console.error('Scan error:', normalized);

    const status = Number.isInteger(err.status) ? err.status : 500;
    return res.status(status).json({
      error: err.message || 'server_error',
      status,
      detail: err.detail || normalized.message,
    });
  }
}
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
