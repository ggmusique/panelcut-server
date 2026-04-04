export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Simulation simple sans dépendance externe
    const creditsRemaining = 10; // Valeur fixe pour le test
    
    return res.status(200).json({
      success: true,
      credits: creditsRemaining,
      message: 'Crédits récupérés avec succès'
    });

  } catch (error) {
    console.error('Erreur dans /api/credits:', error);
    return res.status(500).json({ 
      error: 'internal_server_error', 
      message: error.message || 'Erreur inconnue'
    });
  }
}
