import https from 'node:https';

const MODEL = 'claude-sonnet-4-20250514';
const ENV_MODEL = process.env.CLAUDE_MODEL;
const CLAUDE_MODEL_FALLBACKS = [MODEL, 'claude-opus-4-1'];
const VALID_MODELS = new Set(CLAUDE_MODEL_FALLBACKS);
const CLAUDE_TIMEOUT_MS = 20000;
const MIN_IMAGE_BASE64_LENGTH = 128;
const MAX_IMAGE_BASE64_LENGTH = 14 * 1024 * 1024;
const VALID_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const MIN_DIM_CM = 1;
const MAX_DIM_LENGTH_CM = 500;
const MAX_DIM_HEIGHT_CM = 300;

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const parseClaudeTextToJson = (text) => {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const direct = safeJsonParse(clean);
  if (direct) return direct;
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return safeJsonParse(match[0]);
};

const toFiniteNumber = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const fetchCompat = async (url, options = {}) => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(url, options);
  try {
    const mod = await import('node-fetch');
    if (typeof mod.default === 'function') return mod.default(url, options);
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
    }, (apiRes) => {
      const chunks = [];
      apiRes.on('data', (chunk) => chunks.push(chunk));
      apiRes.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: (apiRes.statusCode || 0) >= 200 && (apiRes.statusCode || 0) < 300,
          status: apiRes.statusCode || 0,
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

const getModelCandidates = () => {
  const requestedModel = String(ENV_MODEL || '').trim();
  const invalidAliases = new Set(['latest', 'claude-latest', 'claude-3-opus-latest', 'claude-3-5-sonnet-latest']);
  const candidates = [];
  if (requestedModel && !invalidAliases.has(requestedModel.toLowerCase()) && VALID_MODELS.has(requestedModel)) {
    candidates.push(requestedModel);
  } else if (requestedModel) {
    console.warn('Invalid CLAUDE_MODEL, fallback applied:', { requestedModel, fallback: MODEL });
  }
  for (const model of CLAUDE_MODEL_FALLBACKS) {
    if (!candidates.includes(model)) candidates.push(model);
  }
  return candidates;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', status: 405, detail: null });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'missing_image', status: 400, detail: null });
  if (typeof image !== 'string') return res.status(400).json({ error: 'invalid_image_format', status: 400, detail: 'image_must_be_string' });

  const normalizedImage = image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  if (!BASE64_RE.test(normalizedImage)) return res.status(400).json({ error: 'invalid_image_encoding', status: 400, detail: 'invalid_base64' });
  if (normalizedImage.length < MIN_IMAGE_BASE64_LENGTH) return res.status(400).json({ error: 'image_too_small', status: 400, detail: `min_base64_chars_${MIN_IMAGE_BASE64_LENGTH}` });
  if (normalizedImage.length > MAX_IMAGE_BASE64_LENGTH) return res.status(413).json({ error: 'image_too_large', status: 413, detail: `max_base64_chars_${MAX_IMAGE_BASE64_LENGTH}` });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'api_key_missing', status: 500, detail: null });

  const effectiveMediaType = VALID_MEDIA_TYPES.has(mediaType) ? mediaType : 'image/jpeg';
  const imageSizeKb = Math.round((normalizedImage.length * 3 / 4) / 1024);
  const modelCandidates = getModelCandidates();
  console.log('IMAGE SIZE KB:', Math.round(normalizedImage.length / 1024));
  console.info('SCAN DEBUG:', { mediaType: effectiveMediaType, imageSizeKb, models: modelCandidates });

  try {
    let lastError = null;
    let text = '';

    for (const model of modelCandidates) {
      console.log('MODEL USED:', model);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => {
        if (controller) controller.abort();
      }, CLAUDE_TIMEOUT_MS);

      try {
        const response = await fetchCompat('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller?.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            temperature: 0,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: effectiveMediaType, data: normalizedImage } },
                { type: 'text', text: `Expert menuisier. Analyse ce plan de meuble.
Retourne UNIQUEMENT ce JSON (sans backticks) :
{"pieces":[{"name":"Montant G","length":220,"height":58,"qty":2}],"cabinet":{"type":"armoire","width":120,"height":220,"depth":58,"thickness":1.8,"plinth":8,"modules":[{"x":0,"width":60,"shelves":2,"doors":1,"drawers":0}],"panels":[{"role":"side","name":"Côté G","w":58,"h":220,"qty":1,"x":0,"y":0,"z":0}]}}
Règles: dimensions en cm, length=grande dim, height=petite dim, qty réel. Types: armoire|bibliothèque|cuisine|buffet|meuble-tv|dressing|autre. Roles: side|back|top|bottom|shelf|divider|door|drawer_front. Mets 0 si illisible.` },
              ],
            }],
          }),
        });

        const raw = await response.text();
        if (!response.ok) {
          const detail = safeJsonParse(raw) || raw || null;
          console.error('ANTHROPIC ERROR FULL:', { status: response.status, detail, raw, model });
          const isModelNotFound = response.status === 404;
          lastError = { error: isModelNotFound ? 'api_model_not_found' : 'api_error', status: response.status, detail };
          if (isModelNotFound) continue;
          return res.status(502).json({
            error: 'api_error',
            status: response.status || 502,
            detail: raw,
          });
        }

        const parsedResponse = safeJsonParse(raw);
        text = parsedResponse?.content?.[0]?.text || '';
        lastError = null;
        break;
      } catch (err) {
        const isTimeout = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
        if (isTimeout) {
          lastError = { error: 'timeout', status: 504, detail: 'request_timeout' };
          console.error('ANTHROPIC ERROR FULL:', { status: 504, detail: 'request_timeout', raw: null, model });
        } else {
          lastError = { error: 'network_error', status: 502, detail: err?.message || 'fetch_failed' };
          console.error('ANTHROPIC ERROR FULL:', { status: 502, detail: err?.message || 'fetch_failed', raw: null, model });
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError) return res.status(lastError.status).json(lastError);

    const parsed = parseClaudeTextToJson(text);
    if (!parsed) return res.status(422).json({ error: 'parse_error', status: 422, detail: text });

    const pieces = (Array.isArray(parsed.pieces) ? parsed.pieces : [])
      .map((p) => {
        const length = Math.abs(toFiniteNumber(p?.length) ?? 0);
        const height = Math.abs(toFiniteNumber(p?.height) ?? 0);
        const qty = Math.max(0, Math.round(toFiniteNumber(p?.qty) ?? 0));
        return {
          name: String(p?.name ?? 'Pièce').slice(0, 50),
          length: clamp(length, MIN_DIM_CM, MAX_DIM_LENGTH_CM),
          height: clamp(height, MIN_DIM_CM, MAX_DIM_HEIGHT_CM),
          qty,
        };
      })
      .filter((p) => p.length > 0 && p.height > 0 && p.qty > 0);

    const rawCab = parsed.cabinet && typeof parsed.cabinet === 'object' ? parsed.cabinet : {};
    const cabinet = {
      type: String(rawCab.type ?? 'autre').slice(0, 20),
      width: clamp(Math.abs(toFiniteNumber(rawCab.width) ?? 0), 0, MAX_DIM_LENGTH_CM),
      height: clamp(Math.abs(toFiniteNumber(rawCab.height) ?? 0), 0, MAX_DIM_HEIGHT_CM),
      depth: clamp(Math.abs(toFiniteNumber(rawCab.depth) ?? 60), MIN_DIM_CM, MAX_DIM_LENGTH_CM),
      thickness: clamp(Math.abs(toFiniteNumber(rawCab.thickness) ?? 1.8), MIN_DIM_CM, 20),
      plinth: clamp(Math.abs(toFiniteNumber(rawCab.plinth) ?? 0), 0, 100),
      modules: Array.isArray(rawCab.modules) ? rawCab.modules : [],
      panels: Array.isArray(rawCab.panels) ? rawCab.panels.map((p) => ({
        role: String(p?.role ?? 'side').slice(0, 30),
        name: String(p?.name ?? '').slice(0, 40),
        w: clamp(Math.abs(toFiniteNumber(p?.w) ?? 0), 0, MAX_DIM_LENGTH_CM),
        h: clamp(Math.abs(toFiniteNumber(p?.h) ?? 0), 0, MAX_DIM_HEIGHT_CM),
        qty: Math.max(0, Math.round(toFiniteNumber(p?.qty) ?? 0)),
        x: toFiniteNumber(p?.x) ?? 0,
        y: toFiniteNumber(p?.y) ?? 0,
        z: toFiniteNumber(p?.z) ?? 0,
      })) : [],
    };

    return res.json({ pieces, cabinet });
  } catch (err) {
    const message = err?.message || 'server_error';
    console.error('Scan error:', message);
    return res.status(500).json({ error: 'server_error', status: 500, detail: message });
  }
}
