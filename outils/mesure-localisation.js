#!/usr/bin/env node
/* Mesure de la localisation — lecture seule.
   Vérité terrain : biens dont l'adresse est sûre
     - adresse écrite par le vendeur (numéro + voie) retrouvée dans ban/<commune>.json
     - position relevée sur place ou adresse confirmée (colonne « position » du Google Sheet)
   Mesures :
     A. distance entre le point Melo (flouté par le portail) et la vraie adresse
     B. recherche DPE (ADEME) : méthode actuelle vs méthode enrichie (date du diagnostic,
        année de construction, étage) — la vraie adresse est-elle trouvée, à quel rang ?
   Usage : node outils/mesure-localisation.js [--page design/index.html] [--sans-dpe]
*/
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const pageArg = args.indexOf('--page');
const page = path.resolve(pageArg >= 0 ? args[pageArg + 1] : path.join(__dirname, '..', 'design', 'index.html'));
const dossier = path.dirname(page);
const sansDpe = args.includes('--sans-dpe');

const src = fs.readFileSync(page, 'utf8');
const lignes = src.split(/\r?\n/);
const d0 = lignes.findIndex(l => /^\s*const RAW = \[\s*$/.test(l));
const d1 = lignes.findIndex((l, i) => i > d0 && /^\s*\];\s*$/.test(l));
const RAW = Function('return [' + lignes.slice(d0 + 1, d1).join('\n') + ']')();
const CP = JSON.parse((src.match(/this\.CP = (\{[^}]*\})/) || [, '{}'])[1]);
const SYNC = (src.match(/this\.SYNC_URL = "([^"]*)"/) || [, ''])[1];

/* mêmes règles que la page */
const normCommune = t => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^(la|le|les|l')[\s'’-]+/, '').replace(/\bste\b/g, 'sainte').replace(/\bst\b/g, 'saint').replace(/[^a-z]/g, '');
const normAdr = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function adresseTexte(texte) {
  const t = (texte || '').replace(/\s+/g, ' ');
  const V = '(?:rue|avenue|boulevard|chemin|impasse|place|allée|route|quai|cours)';
  const MAJ = "[A-ZÀÂÉÈÊÎÔÛÇ][\\wÀ-ÿ'’\\-]+";
  const LIEN = "(?:de|du|des|la|le|les|d'|l')";
  const SUITE = '(?:\\s+(?:' + LIEN + '\\s+)?' + MAJ + '){0,2}';
  const avecNum = new RegExp('\\b(\\d{1,4}(?:\\s?(?:bis|ter))?)\\s+(' + V + ')\\s+((?:' + LIEN + '\\s+)?' + MAJ + SUITE + ')', 'i');
  const m = t.match(avecNum);
  return m ? { num: m[1].replace(/\s+/g, ' ').toLowerCase(), voie: (m[2] + ' ' + m[3]).trim() } : null;
}
const dist = (a, b, c, d) => {
  const r = Math.PI / 180, R = 6371000;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const stats = v => {
  if (!v.length) return 'n = 0';
  const s = [...v].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n = ${s.length} · médiane ${Math.round(q(.5))} m · 75 % sous ${Math.round(q(.75))} m · 90 % sous ${Math.round(q(.9))} m · max ${Math.round(s[s.length - 1])} m`;
};

const REF = new Date('2026-09-27T12:00:00Z').getTime();   /* base des « jours » des anciennes lignes */
const biens = RAW.map(r => ({
  titre: r[0], type: r[1], commune: r[2], surface: r[3], dpe: r[7], texte: r[9], url: r[10], lat: r[16], lon: r[17],
  terrain: r[21], annee: r[22], etage: r[23], ges: r[26] || '', source: /pap\.fr/.test(r[10]) ? 'PAP' : 'leboncoin',
  enLigne: r[25] ? new Date(r[25]).getTime() : REF - r[5] * 86400000
}));

const idxBan = JSON.parse(fs.readFileSync(path.join(dossier, 'ban', 'index.json'), 'utf8'));
const slugDe = {}; idxBan.forEach(x => { slugDe[normCommune(x.commune)] = x; });
const banCache = {};
const banDe = c => { const e = slugDe[normCommune(c)]; if (!e) return null;
  return banCache[e.slug] || (banCache[e.slug] = JSON.parse(fs.readFileSync(path.join(dossier, 'ban', e.slug + '.json'), 'utf8'))); };

async function main() {
  /* ---------- vérité terrain ---------- */
  const verite = [];
  for (const b of biens) {
    const ec = adresseTexte(b.texte);
    const ban = ec && banDe(b.commune);
    if (!ban) continue;
    const v = normAdr(ec.voie), n = normAdr(ec.num).replace(/\s/g, '');
    const hit = ban.find(a => normAdr(a[0]).replace(/\s/g, '') === n && normAdr(a[1]) === v)
             || ban.find(a => normAdr(a[0]).replace(/\s/g, '') === n && normAdr(a[1]).endsWith(v.split(' ').slice(1).join(' ')) && v.split(' ').length > 1);
    if (hit) verite.push({ b, lat: hit[2], lon: hit[3], voie: hit[1], num: hit[0], via: 'écrite' });
  }
  if (SYNC) {
    try {
      const j = await (await fetch(SYNC + '?t=' + Date.now())).json();
      for (const x of j.rows || []) {
        if (!x.pin || !x.pin.lat) continue;
        const b = biens.find(y => y.url === x.cle);
        if (!b || verite.some(v => v.b === b)) continue;
        const voie = (x.pin.adresse || '').replace(/^\d+\s*(bis|ter)?\s*/i, '');
        verite.push({ b, lat: x.pin.lat, lon: x.pin.lon, voie, num: '', via: x.pin.via === 'piste' ? 'confirmée' : 'sur place' });
      }
    } catch (e) { console.log('(Sheet illisible : ' + e.message + ')'); }
  }
  const parVia = {}; verite.forEach(v => parVia[v.via] = (parVia[v.via] || 0) + 1);
  console.log(`Vérité terrain : ${verite.length} biens sur ${biens.length} (${Object.entries(parVia).map(([k, n]) => n + ' ' + k).join(', ')})\n`);

  /* ---------- A. décalage du point Melo ---------- */
  console.log('A. Distance point Melo → vraie adresse');
  const ds = verite.filter(v => v.b.lat).map(v => ({ d: dist(v.b.lat, v.b.lon, v.lat, v.lon), s: v.b.source }));
  console.log('   tous       ' + stats(ds.map(x => x.d)));
  for (const s of ['leboncoin', 'PAP']) console.log(`   ${s.padEnd(10)} ` + stats(ds.filter(x => x.s === s).map(x => x.d)));
  const rayon = 600;
  console.log(`   dans le rayon actuel de ${rayon} m : ${ds.filter(x => x.d <= rayon).length} / ${ds.length}`);

  /* rang de la vraie rue parmi les rues triées par distance au point Melo (méthode BAN actuelle, sans indice texte) */
  const rangs = [];
  for (const v of verite) {
    const ban = banDe(v.b.commune); if (!ban || !v.b.lat) continue;
    const voies = {};
    ban.forEach(a => { const d = dist(v.b.lat, v.b.lon, a[2], a[3]); if (d > rayon) return;
      const k = normAdr(a[1]); voies[k] = Math.min(voies[k] ?? 1e9, d); });
    const tri = Object.entries(voies).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const r = tri.indexOf(normAdr(v.voie));
    rangs.push(r < 0 ? Infinity : r + 1);
  }
  const part = k => Math.round(rangs.filter(r => r <= k).length / Math.max(1, rangs.length) * 100);
  console.log(`   rue la plus proche du point = la bonne : ${part(1)} % · dans les 3 premières : ${part(3)} % · dans les 4 affichées : ${part(4)} %\n`);

  if (sansDpe) return;

  /* ---------- B. DPE ---------- */
  console.log('B. Recherche DPE (ADEME)');
  const champs = 'adresse_ban,nom_rue_ban,numero_voie_ban,nom_commune_ban,surface_habitable_logement,type_batiment,_geopoint,date_etablissement_dpe,annee_construction,numero_etage_appartement,etiquette_ges';
  const res = { actuelle: [], enrichie: [] };
  let testables = 0;
  for (const v of verite) {
    const b = v.b;
    const typeBat = b.type === 'Maison' ? 'maison' : b.type === 'Appartement' ? 'appartement' : '';
    const cp = CP[b.commune] || (slugDe[normCommune(b.commune)] || {}).cp;
    if (!b.dpe || !cp || !b.surface || !typeBat) continue;
    testables++;
    const filtres = `&code_postal_ban_eq=${cp}&etiquette_dpe_eq=${b.dpe}&surface_habitable_logement_gte=${Math.max(0, b.surface - 3)}&surface_habitable_logement_lte=${b.surface + 3}`
      + `&type_batiment_in=${typeBat === 'appartement' ? 'appartement,immeuble' : 'maison'}` + (b.lat ? `&geo_distance=${b.lon},${b.lat},1500` : '');
    let rows = [];
    try {
      const j = await (await fetch('https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=300&sort=-date_etablissement_dpe&select=' + champs + filtres)).json();
      rows = (j.results || []).filter(x => x.adresse_ban && normCommune(x.nom_commune_ban) === normCommune(b.commune) &&
        (!x.type_batiment || x.type_batiment === typeBat || (typeBat === 'appartement' && x.type_batiment === 'immeuble')));
    } catch (e) { continue; }
    const juste = x => normAdr(x.adresse_ban).includes(normAdr(v.voie)) || (x.nom_rue_ban && normAdr(x.nom_rue_ban) === normAdr(v.voie));
    const avecDist = rows.map(x => { const [la, lo] = String(x._geopoint || '').split(',').map(Number);
      return Object.assign({ d: la && b.lat ? dist(b.lat, b.lon, la, lo) : null }, x); });
    /* actuelle : une ligne par adresse, ≤ 1500 m, tri par distance */
    const parAdr = l => { const m = {}; l.forEach(x => { if (!m[x.adresse_ban] || (x.sc || 0) > (m[x.adresse_ban].sc || 0)) m[x.adresse_ban] = x; }); return Object.values(m); };
    let act = parAdr(avecDist.filter(x => x.d === null || x.d <= 1500)).sort((a, c) => (a.d ?? 9e9) - (c.d ?? 9e9));
    /* enrichie : score = proximité + DPE établi peu avant la mise en vente + année + étage */
    const enr = parAdr(avecDist.filter(x => x.d === null || x.d <= 1500).map(x => {
      let sc = 50 - (x.d ?? 800) / 30;
      const dd = x.date_etablissement_dpe ? (b.enLigne - new Date(x.date_etablissement_dpe).getTime()) / 86400000 : null;
      if (dd !== null) { if (dd >= -15 && dd <= 120) sc += 40; else if (dd > 120 && dd <= 365) sc += 15; else if (dd > 730) sc -= 10; }
      if (b.annee && x.annee_construction) sc += Math.abs(b.annee - x.annee_construction) <= 3 ? 12 : -6;
      if (b.ges && x.etiquette_ges) sc += x.etiquette_ges === b.ges ? 10 : -10;
      if (b.type === 'Appartement' && b.etage >= 0 && x.numero_etage_appartement != null) sc += Number(x.numero_etage_appartement) === b.etage ? 12 : -8;
      return Object.assign({}, x, { sc });
    })).sort((a, c) => c.sc - a.sc);
    for (const [nom, liste] of [['actuelle', act], ['enrichie', enr]]) {
      const i = liste.findIndex(juste);
      res[nom].push({ rang: i < 0 ? Infinity : i + 1, n: liste.length });
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`   biens testables (DPE + surface + maison/appartement) : ${testables}`);
  for (const nom of ['actuelle', 'enrichie']) {
    const l = res[nom], p = k => Math.round(l.filter(x => x.rang <= k).length / Math.max(1, l.length) * 100);
    const moy = Math.round(l.reduce((a, x) => a + x.n, 0) / Math.max(1, l.length) * 10) / 10;
    console.log(`   ${nom.padEnd(9)} : bonne adresse en 1re position ${p(1)} % · dans les 4 affichées ${p(4)} % · trouvée ${p(999)} % · ${moy} candidats en moyenne`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
