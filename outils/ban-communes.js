#!/usr/bin/env node
/* Ajoute des communes aux fichiers d'adresses embarqués (ban/ et bat/).
   - ban/<slug>.json : adresses de la Base Adresse Nationale [numéro, voie, lat, lon]
   - bat/<slug>.json : lien parcelle cadastrale → adresse (chaque adresse BAN placée
                       dans sa parcelle du plan cadastral Etalab)
   Usage :
     node outils/ban-communes.js --csv adresses-34.csv.gz --csv adresses-11.csv.gz [--dossier design] Commune1 "Commune 2" …
   Les CSV départementaux se téléchargent sur
     https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-<dép>.csv.gz
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const csvs = [], communes = [];
let dossier = path.join(__dirname, '..', 'design');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--csv') csvs.push(args[++i]);
  else if (args[i] === '--dossier') dossier = path.resolve(args[++i]);
  else communes.push(args[i]);
}
if (!csvs.length || !communes.length) {
  console.error('node outils/ban-communes.js --csv adresses-34.csv.gz [--csv …] [--dossier design] Commune …');
  process.exit(1);
}

/* même normalisation que normCommune() dans la page */
const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^(la|le|les|l')[\s'’-]+/, '').replace(/\bste\b/g, 'sainte').replace(/\bst\b/g, 'saint').replace(/[^a-z]/g, '');
const slugDe = t => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/* libellé des fichiers bat/ : minuscules, sans accents, « 1bis rue de l ermite » */
const libelle = (num, rep, voie) => ((num || '') + (rep || '') + ' ' + voie).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/* point dans polygone (GeoJSON Polygon / MultiPolygon, lon/lat) */
function dansAnneau(x, y, anneau) {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}
function dansGeom(x, y, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some(p => dansAnneau(x, y, p[0]) && !p.slice(1).some(t => dansAnneau(x, y, t)));
}
function boite(g) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const tour = co => { if (typeof co[0] === 'number') { a = Math.min(a, co[0]); b = Math.min(b, co[1]); c = Math.max(c, co[0]); d = Math.max(d, co[1]); } else co.forEach(tour); };
  tour(g.coordinates);
  return [a, b, c, d];
}

const parcelleEn = (ps, x, y) => ps.find(p => x >= p.b[0] && x <= p.b[2] && y >= p.b[1] && y <= p.b[3] && dansGeom(x, y, p.g));
/* La BAN pose souvent le point devant l'entrée, sur la voirie : on sonde autour
   (6 puis 12 m, 8 directions) et on garde la parcelle la plus souvent touchée. */
function parcelleProche(ps, x, y) {
  const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(y * Math.PI / 180));
  for (const r of [6, 12]) {
    const vus = new Map();
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      const p = parcelleEn(ps, x + Math.cos(a) * r * mLon, y + Math.sin(a) * r * mLat);
      if (p) vus.set(p, (vus.get(p) || 0) + 1);
    }
    if (vus.size) return [...vus.entries()].sort((u, v) => v[1] - u[1])[0][0];
  }
  return null;
}

async function main() {
  const voulues = new Map(communes.map(c => [norm(c), c]));
  const trouvees = new Map();                      /* norm → { nom, insee, cp, lignes[] } */
  for (const f of csvs) {
    const lignes = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n');
    const h = lignes[0].split(';'); const c = n => h.indexOf(n);
    const I = { num: c('numero'), rep: c('rep'), voie: c('nom_voie'), cp: c('code_postal'), insee: c('code_insee'),
                com: c('nom_commune'), lat: c('lat'), lon: c('lon') };
    for (let i = 1; i < lignes.length; i++) {
      const v = lignes[i].split(';');
      if (v.length < 10) continue;
      const k = norm(v[I.com]);
      if (!voulues.has(k)) continue;
      const t = trouvees.get(k) || { nom: v[I.com], insee: v[I.insee], cp: v[I.cp], lignes: [] };
      t.lignes.push({ num: v[I.num], rep: v[I.rep], voie: v[I.voie], lat: Number(v[I.lat]), lon: Number(v[I.lon]) });
      trouvees.set(k, t);
    }
  }

  const banIdxF = path.join(dossier, 'ban', 'index.json'), batIdxF = path.join(dossier, 'bat', 'index.json');
  const banIdx = JSON.parse(fs.readFileSync(banIdxF, 'utf8')), batIdx = JSON.parse(fs.readFileSync(batIdxF, 'utf8'));

  for (const [k, nomDemande] of voulues) {
    const t = trouvees.get(k);
    if (!t) { console.log(`✗ ${nomDemande} : absente des CSV fournis`); continue; }
    const slug = slugDe(t.nom);
    const ban = t.lignes.map(a => [a.rep ? a.num + ' ' + a.rep : a.num, a.voie, a.lat, a.lon]);

    /* plan cadastral de la commune (Etalab) */
    const r = await fetch(`https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes/${t.insee}/geojson/parcelles`);
    if (!r.ok) throw new Error(`cadastre ${t.insee} : HTTP ${r.status}`);
    let brut = Buffer.from(await r.arrayBuffer());
    if (brut[0] === 0x1f && brut[1] === 0x8b) brut = zlib.gunzipSync(brut);
    const parcelles = JSON.parse(brut.toString('utf8')).features
      .filter(f => f.geometry && f.properties && f.properties.id)
      .map(f => ({ id: f.properties.id, g: f.geometry, b: boite(f.geometry) }));

    const adr = {}, parc = {};
    let places = 0;
    for (const a of t.lignes) {
      const lib = libelle(a.num, a.rep, a.voie);
      const p = parcelleEn(parcelles, a.lon, a.lat) || parcelleProche(parcelles, a.lon, a.lat);
      if (!p) continue;
      places++;
      if (!adr[lib]) adr[lib] = [0, 0, 0, 0, p.id];  /* colonnes BDNB non renseignées (inutilisées par la page) */
      if (!parc[p.id]) parc[p.id] = lib;
    }

    const banTxt = JSON.stringify(ban), batTxt = JSON.stringify({ adr, parc });
    fs.writeFileSync(path.join(dossier, 'ban', slug + '.json'), banTxt);
    fs.writeFileSync(path.join(dossier, 'bat', slug + '.json'), batTxt);
    const majIdx = (idx, e) => { const i = idx.findIndex(x => norm(x.commune) === k); if (i >= 0) idx[i] = e; else idx.push(e); };
    majIdx(banIdx, { slug, commune: t.nom, cp: t.cp, adresses: ban.length, octets: Buffer.byteLength(banTxt) });
    majIdx(batIdx, { slug, commune: t.nom, adresses: Object.keys(adr).length, parcelles: Object.keys(parc).length, octets: Buffer.byteLength(batTxt) });
    console.log(`✓ ${t.nom} (${t.insee}, ${t.cp}) : ${ban.length} adresses, ${places} placées dans ${Object.keys(parc).length} parcelles`);
  }
  banIdx.sort((a, b) => a.slug.localeCompare(b.slug)); batIdx.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(banIdxF, JSON.stringify(banIdx, null, 1)); fs.writeFileSync(batIdxF, JSON.stringify(batIdx, null, 1));
}
main().catch(e => { console.error(e.message); process.exit(1); });
