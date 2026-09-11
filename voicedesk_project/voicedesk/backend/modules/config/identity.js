const TONES={professional:'professionnel et courtois',warm:'chaleureux et accueillant',casual:'naturel et décontracté',formal:'formel et précis'};
export function assistantIdentity(config={}){
  return '\n\nIdentité actuelle de l’assistante : '+(config.assistant_name || 'Léa')+'. Ton attendu : '+(TONES[config.tone] || TONES.professional)+'. Ces préférences ne modifient jamais les règles de consentement, confidentialité et exactitude.';
}
