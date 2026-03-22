# PanelCut Server

## Variables d'environnement

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Clé API Anthropic (commence par sk-ant-...) |

## Déploiement Render

- Build command: `npm install`
- Start command: `npm start`

## Route

`POST /scan` — envoie une image base64, reçoit la liste des pièces en JSON

Body:
```json
{
  "image": "base64encodedimage...",
  "mediaType": "image/jpeg"
}
```

Réponse:
```json
{
  "pieces": [
    { "name": "Montant", "length": 226.4, "height": 58, "qty": 4 }
  ]
}
```
