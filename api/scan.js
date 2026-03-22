export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType || "image/jpeg",
                data: image
              }
            },
            {
              type: "text",
              text: `Tu es un expert menuisier. Analyse ce plan de découpe et extrait toutes les pièces.
Retourne UNIQUEMENT ce JSON valide, rien d'autre, pas de backticks, pas de texte avant ou après :
{"pieces":[{"name":"Montant","length":226.4,"height":58,"qty":4}]}

Règles :
- Dimensions en cm
- length = plus grande dimension de la pièce
- height = plus petite dimension de la pièce  
- qty = quantité (cherche annotations x4, 4P, (4), ×4... sinon mets 1)
- name = type de pièce (montant, tablette, étagère, traverse, dos, fond, côté, pied...)
- Extrait TOUTES les pièces visibles`
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
      parsed = JSON.parse(clean);
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

    res.json({ pieces });

  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
}
