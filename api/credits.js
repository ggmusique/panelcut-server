import { v4 as uuidv4 } from 'uuid'; // Si tu utilises uuid, sinon on l'enlève

export default async function handler(req, res) {
  // Autoriser uniquement les requêtes GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // SIMULATION : À remplacer plus tard par ta logique de base de données
    // Pour l'instant, on renvoie un nombre fixe ou aléatoire pour tester
    const creditsRemaining = Math.floor(Math.random() * 10) + 5; // Entre 5 et 15 scans
    
    return res.status(200).json({
      success: true,
      credits: creditsRemaining,
      message: 'Crédits récupérés avec succès'
    });

  } catch (error) {
    console.error('Erreur dans /api/credits:', error);
    return res.status(500).json({ 
      error: 'internal_server_error', 
      message: error.message 
    });
  }
}
