export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const { image, mediaType } = req.body;
  if (!image) return res.status(400).json({ error: "missing_image" });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "api_key_missing" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType || "image/jpeg", data: image }
            },
            {
              type: "text",
              text: `Tu es un expert menuisier-ébéniste et dessinateur industriel.
Analyse ce plan de meuble (croquis à main levée, plan technique ou photo).

Retourne UNIQUEMENT ce JSON valide, sans backticks, sans texte autour :

{
  "pieces": [
    {"name": "Montant G", "length": 226.4, "height": 58, "qty": 2}
  ],
  "cabinet": {
    "type": "armoire",
    "width": 120,
    "height": 220,
    "depth": 58,
    "thickness": 1.8,
    "plinth": 8,
    "modules": [
      { "x": 0, "width": 60, "shelves": 3, "doors": 1, "drawers": 0 },
      { "x": 60, "width": 60, "shelves": 2, "doors": 0, "drawers": 3 }
    ],
    "panels": [
      { "role": "side",    "name": "Côté G",    "w": 58,  "h": 220, "qty": 1, "x": 0,    "y": 0, "z": 0 },
      { "role": "side",    "name": "Côté D",    "w": 58,  "h": 220, "qty": 1, "x": 120,  "y": 0, "z": 0 },
      { "role": "back",    "name": "Fond",      "w": 120, "h": 220, "qty": 1, "x": 0,    "y": 0, "z": 58 },
      { "role": "top",     "name": "Dessus",    "w": 120, "h": 58,  "qty": 1, "x": 0,    "y": 220,"z": 0 },
      { "role": "bottom",  "name": "Fond bas",  "w": 120, "h": 58,  "qty": 1, "x": 0,    "y": 8,  "z": 0 },
      { "role": "shelf",   "name": "Tablette",  "w": 116, "h": 58,  "qty": 3, "x": 2,    "y": 60, "z": 0 },
      { "role": "divider", "name": "Séparation","w": 58,  "h": 200, "qty": 1, "x": 60,   "y": 8,  "z": 0 }
    ]
  }
}

RÈGLES STRICTES :

== PIECES (liste pour la découpe) ==
- dimensions en cm, length = grande dimension, height = petite dimension
- qty = quantité réelle (lis x4, 4P, ×4, sinon 1)
- name = type précis (Montant G/D, Tablette, Traverse H/B, Fond, Côté G/D, Étagère, Séparation...)
- Extrait TOUTES les pièces visibles sur le plan

== CABINET (modèle structuré du meuble entier) ==
- type : "armoire" | "bibliothèque" | "cuisine" | "buffet" | "meuble-tv" | "dressing" | "autre"
- width, height, depth : dimensions globales en cm (0 si illisible)
- thickness : épaisseur des panneaux en cm (défaut 1.8)
- plinth : hauteur de la plinthe en cm (0 si absente)
- modules : liste des corps/colonnes du meuble, chacun avec :
    x = position X de départ en cm depuis la gauche
    width = largeur en cm
    shelves = nombre de tablettes intérieures
    doors = nombre de portes (0 si aucune)
    drawers = nombre de tiroirs (0 si aucun)
- panels : liste COMPLÈTE des panneaux structurels avec :
    role = "side" | "back" | "top" | "bottom" | "shelf" | "divider" | "door" | "drawer_front"
    name = nom affiché
    w = largeur en cm
    h = hauteur en cm
    qty = quantité
    x, y, z = position 3D en cm dans le repère du meuble (origine = coin bas-gauche-avant)
        x = position gauche-droite
        y = position bas-haut (0 = sol, plinth inclu)
        z = position avant-arrière (0 = face avant, depth = fond)
- Si tu ne peux pas lire une valeur, mets 0 pour les nombres et "autre" pour le type
- Ne jamais omettre le champ cabinet même si vide : retourne cabinet avec width:0 si illisible`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(500).json({ error: "api_error", detail: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let parsed;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      const match = clean.match(/{[\s\S]*}/);
      parsed = JSON.parse(match ? match[0] : clean);
    } catch {
      return res.status(422).json({ error: "parse_error", raw: text });
    }

    const pieces = (parsed.pieces || [])
      .filter(p => p.length > 0 && p.height > 0)
      .map(p => ({
        name:   String(p.name || "Pièce").slice(0, 50),
        length: Math.abs(parseFloat(p.length) || 0),
        height: Math.abs(parseFloat(p.height) || 0),
        qty:    Math.max(1, Math.round(parseFloat(p.qty) || 1)),
      }))
      .filter(p => p.length > 0 && p.height > 0);

    const rawCab = parsed.cabinet || {};
    const cabinet = {
      type:      rawCab.type      || "autre",
      width:     parseFloat(rawCab.width)     || 0,
      height:    parseFloat(rawCab.height)    || 0,
      depth:     parseFloat(rawCab.depth)     || 60,
      thickness: parseFloat(rawCab.thickness) || 1.8,
      plinth:    parseFloat(rawCab.plinth)    || 0,
      modules:   Array.isArray(rawCab.modules) ? rawCab.modules : [],
      panels:    Array.isArray(rawCab.panels)  ? rawCab.panels.map(p => ({
        role: p.role || "side",
        name: String(p.name || "").slice(0, 40),
        w:    parseFloat(p.w) || 0,
        h:    parseFloat(p.h) || 0,
        qty:  Math.max(1, parseInt(p.qty) || 1),
        x:    parseFloat(p.x) || 0,
        y:    parseFloat(p.y) || 0,
        z:    parseFloat(p.z) || 0,
      })) : [],
    };

    res.json({ pieces, cabinet });

  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
}
