# Radar Mandats — service local de coordonnées

Sert la page `design/` sur l'ordinateur et ajoute la recherche de coordonnées PagesBlanches
(bouton **Rechercher les coordonnées** dans le tiroir « L'annonce du vendeur » d'un bien).

Sur GitHub Pages, le bouton est visible mais indique que la recherche n'est disponible
qu'avec ce service lancé.

## Lancer

Prérequis : Node.js 22 ou ultérieur et Google Chrome.

```bash
cd coordonnees
npm install
npm start
```

Ouvrir ensuite [http://localhost:3000](http://localhost:3000). Laisser le terminal ouvert, `Ctrl+C` pour arrêter.

Sans Google Chrome : `npm run browser:install` (installe le Chromium de Playwright).

## Fonctionnement

1. Ouvrir un bien, confirmer son adresse (tiroir « Adresse »).
2. Tiroir « L'annonce du vendeur » → **Rechercher les coordonnées**.
3. Les noms et téléphones trouvés s'affichent sous **Annonceur**.

- Les résultats sont gardés dans `radar-state.json` (non versionné : données personnelles).
- Le moteur utilise un profil Chrome séparé dans `.browser-profile/` (non versionné), fenêtre hors écran.
- Si PagesJaunes demande un consentement ou une vérification, Chrome apparaît : faire l'étape, puis **Réessayer** dans Radar. Le moteur ne contourne ni CAPTCHA ni contrôle d'accès.

## Configuration

Variables optionnelles : `PORT` (3000), `STATE_FILE`, `PB_PROFILE_DIR`, `DESIGN_DIR` (`../design`).
