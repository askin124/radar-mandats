#!/usr/bin/env node
/* Import Melo → Radar Mandats
   Fusionne une ou plusieurs réponses Melo (GET /documents/properties, JSON brut de Postman)
   dans le tableau RAW de la page, sans rien effacer :
   - bien inconnu            → ajouté
   - bien déjà présent       → prix, baisses, photos, statut en ligne, agence mis à jour ;
                               son URL ne change jamais (c'est la clé du suivi dans le Google Sheet)
   - bien absent de l'import → laissé tel quel
   Usage :
     node outils/melo-import.js [--page design/index.html] [--dry] reponse1.json reponse2.json …
*/
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const pageArg = args.indexOf('--page');
const page = path.resolve(pageArg >= 0 ? args[pageArg + 1] : path.join(__dirname, '..', 'design', 'index.html'));
const fichiers = args.filter((a, i) => !a.startsWith('--') && (pageArg < 0 || i !== pageArg + 1));
if (!fichiers.length) {
  console.error('Indiquez au moins un fichier de réponse Melo.\n  node outils/melo-import.js [--page design/index.html] [--dry] reponse.json …');
  process.exit(1);
}

/* ---------- lecture du tableau RAW de la page ---------- */
const html = fs.readFileSync(page, 'utf8');
const eol = html.includes('\r\n') ? '\r\n' : '\n';
const lignes = html.split(/\r?\n/);
const debut = lignes.findIndex(l => /^\s*const RAW = \[\s*$/.test(l));
const fin = lignes.findIndex((l, i) => i > debut && /^\s*\];\s*$/.test(l));
if (debut < 0 || fin < 0) throw new Error('Tableau « const RAW = [ … ]; » introuvable dans ' + page);
const indent = (lignes[debut + 1].match(/^\s*/) || [''])[0];
const existants = Function('"use strict"; return [' + lignes.slice(debut + 1, fin).join('\n') + '];')();

/* Colonnes du tableau RAW (voir build() dans la page) */
const C = { titre: 0, type: 1, commune: 2, surface: 3, prix: 4, jours: 5, histoPrix: 6, dpe: 7, republi: 8, texte: 9, url: 10,
  refusAgence: 11, actif: 12, cible: 13, pics: 14, nom: 15, lat: 16, lon: 17, enAgence: 18, agence: 19, dateAgence: 20,
  terrain: 21, annee: 22, etage: 23, etagesImm: 24, misEnLigne: 25 };

/* ---------- Melo → ligne RAW ---------- */
const TYPES = { 0: 'Appartement', 1: 'Maison', 5: 'Terrain', 6: 'Commerce' };
const REFUS = /s['’]\s?abst|pas d['’]agences?|sans agences?\b|agences?\s+(immobili[eè]res?\s+)?(merci\s+de\s+)?(ne\s+pas|s['’]abstenir)|remercie[^.]{0,60}(professionnels|agences)|(uniquement|seulement|exclusivement)\s+(entre\s+|aux\s+|de\s+|à\s+)?particuliers|particuliers?\s+(uniquement|seulement|exclusivement)|ni\s+agences?|agences?\s+(immobili[eè]res?\s+)?non\s+merci/i;
const MAX_TEXTE = 480;
const MAINTENANT = Date.now();

const jour = iso => (iso || '').slice(0, 10);
const joursDepuis = iso => Math.max(0, Math.floor((MAINTENANT - new Date(iso).getTime()) / 86400000));
const texteCourt = t => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_TEXTE) return s;
  /* coupe sans laisser d'espace final ni d'emoji coupé en deux */
  return s.slice(0, MAX_TEXTE).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
};
/* Les annonces PAP republiées par le flux « DB » sous le nom « Pap » ne sont pas une agence. */
const estAgence = a => a.publisher && a.publisher.type === 1 && a.contact && a.contact.agency && !/^pap$/i.test(a.contact.agency.trim());
const estPortail = a => a.publisher && a.publisher.type === 0;

function versLigne(p) {
  const portails = p.adverts.filter(estPortail);
  const principal = portails[0] || p.adverts[0];
  const agence = p.adverts.filter(estAgence).sort((x, y) => x.createdAt.localeCompare(y.createdAt))[0];
  const baisses = p.adverts.flatMap(a => (a.events || [])
      .filter(e => e.fieldName === 'price' && e.fieldOldValue != null && Number(e.fieldNewValue) < Number(e.fieldOldValue))
      .map(e => [jour(e.createdAt), Math.round((e.percentVariation || 0) * 10) / 10, Number(e.fieldOldValue), Number(e.fieldNewValue)]))
    .sort((x, y) => x[0].localeCompare(y[0]));
  const avecDpe = p.adverts.find(a => a.energy && a.energy.category);
  const annee = (p.adverts.find(a => a.constructionYear) || {}).constructionYear || 0;
  const etages = (p.adverts.find(a => a.floorQuantity != null) || {}).floorQuantity;
  const terrain = p.landSurface || (p.adverts.find(a => a.landSurface) || {}).landSurface || 0;
  const nom = (portails.find(a => a.contact && a.contact.name) || {}).contact;
  const texte = p.description || principal.description || '';
  const r = [];
  r[C.titre] = String(p.title || principal.title || '').replace(/\s+/g, ' ').trim().slice(0, 70).trimEnd();
  r[C.type] = TYPES[p.propertyType] || 'Maison';
  r[C.commune] = (p.city && p.city.name) || '';
  r[C.surface] = Math.round(p.surface || 0);
  r[C.prix] = p.price || 0;
  r[C.jours] = joursDepuis(p.createdAt);
  r[C.histoPrix] = baisses;
  r[C.dpe] = (avecDpe && avecDpe.energy.category) || '';
  r[C.republi] = p.adverts.filter(a => a.publisher && a.publisher.name === 'LBC').length;
  r[C.texte] = texteCourt(texte);
  r[C.url] = principal.url;
  r[C.refusAgence] = REFUS.test(texte);
  r[C.actif] = !p.expired;
  r[C.cible] = true;
  r[C.pics] = (p.pictures || []).slice(0, 3);
  r[C.nom] = (nom && nom.name) || '';
  r[C.lat] = p.location ? p.location.lat : 0;
  r[C.lon] = p.location ? p.location.lon : 0;
  r[C.enAgence] = !!agence;
  r[C.agence] = agence ? agence.contact.agency.trim() : '';
  r[C.dateAgence] = agence ? jour(agence.createdAt) : '';
  r[C.terrain] = terrain;
  r[C.annee] = annee;
  r[C.etage] = p.floor == null ? -1 : p.floor;
  r[C.etagesImm] = etages || 0;
  r[C.misEnLigne] = jour(p.createdAt);
  return r;
}

/* ---------- fusion ---------- */
const parUrl = new Map(existants.map((r, i) => [r[C.url], i]));
const fusion = existants.map(r => r.slice());
const change = new Set();
const bilan = { lus: 0, nouveaux: [], majs: 0, baisses: [], agence: [], retires: [], ignores: 0 };
const vus = new Set();

for (const f of fichiers) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const membres = j['hydra:member'] || [];
  const total = j['hydra:totalItems'];
  const vue = j['hydra:view'] || {};
  console.log(`• ${path.basename(f)} : ${membres.length} biens` + (total != null ? ` sur ${total}` : '') + (vue['hydra:next'] ? '  ⚠ il reste des pages (hydra:next)' : ''));
  for (const p of membres) {
    if (!p.adverts || !p.adverts.length || vus.has(p.uuid)) continue;
    vus.add(p.uuid);
    bilan.lus++;
    const neuf = versLigne(p);
    const idx = p.adverts.map(a => parUrl.get(a.url)).find(i => i !== undefined);
    if (idx === undefined) {
      if (p.expired) { bilan.ignores++; continue; }        /* déjà retirée : rien à travailler */
      fusion.unshift(neuf);
      parUrl.clear(); fusion.forEach((r, i) => parUrl.set(r[C.url], i));
      bilan.nouveaux.push(neuf[C.titre] + ' — ' + neuf[C.commune] + ' — ' + neuf[C.prix] + ' €');
      continue;
    }
    const ancien = fusion[idx];
    const maj = ancien.slice();
    /* On garde l'URL, le titre et le texte déjà connus ; le reste suit Melo. */
    for (const k of ['prix', 'histoPrix', 'dpe', 'republi', 'refusAgence', 'actif', 'pics', 'nom', 'lat', 'lon',
                     'enAgence', 'agence', 'dateAgence', 'terrain', 'annee', 'etage', 'etagesImm', 'misEnLigne', 'jours']) {
      if (k === 'pics' && !neuf[C.pics].length) continue;
      if (k === 'nom' && !neuf[C.nom]) continue;
      maj[C[k]] = neuf[C[k]];
    }
    maj[C.texte] = texteCourt(maj[C.texte]);
    if (ancien[C.prix] !== maj[C.prix]) bilan.baisses.push(`${maj[C.titre]} : ${ancien[C.prix]} → ${maj[C.prix]} €`);
    if (!ancien[C.enAgence] && maj[C.enAgence]) bilan.agence.push(`${maj[C.titre]} → ${maj[C.agence]}`);
    if (ancien[C.actif] && !maj[C.actif]) bilan.retires.push(maj[C.titre]);
    if (JSON.stringify(ancien) !== JSON.stringify(maj)) { fusion[idx] = maj; change.add(maj); bilan.majs++; }
  }
}

/* ---------- écriture (lignes inchangées gardées à l'identique) ---------- */
const fmt = v => Array.isArray(v) ? '[' + v.map(fmt).join(', ') + ']' : JSON.stringify(v);
const anciennesLignes = new Map(existants.map((r, i) => [r, lignes[debut + 1 + i]]));
const origine = new Map(existants.map((r, i) => [r[C.url], r]));
const sortie = fusion.map((r, i) => {
  const o = origine.get(r[C.url]);
  const ligne = (o && JSON.stringify(o) === JSON.stringify(r)) ? anciennesLignes.get(o).replace(/,\s*$/, '') : indent + fmt(r);
  return ligne + (i < fusion.length - 1 ? ',' : '');
});
const resultat = [...lignes.slice(0, debut + 1), ...sortie, ...lignes.slice(fin)].join(eol);

console.log(`\n${bilan.lus} biens lus · ${bilan.nouveaux.length} nouveaux · ${bilan.majs} mis à jour · ${bilan.ignores} déjà retirés ignorés · ${fusion.length} biens au total`);
if (bilan.nouveaux.length) console.log('\nNouveaux :\n  ' + bilan.nouveaux.join('\n  '));
if (bilan.baisses.length) console.log('\nPrix modifiés :\n  ' + bilan.baisses.join('\n  '));
if (bilan.agence.length) console.log('\nPassés en agence :\n  ' + bilan.agence.join('\n  '));
if (bilan.retires.length) console.log('\nAnnonces retirées :\n  ' + bilan.retires.join('\n  '));

if (dry) console.log('\n(--dry : page non modifiée)');
else { fs.writeFileSync(page, resultat); console.log('\n→ ' + path.relative(process.cwd(), page) + ' mis à jour'); }
