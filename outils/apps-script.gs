/**
 * Radar Mandats — base partagée de l'équipe
 *
 * Une ligne par bien travaillé : qui s'en occupe, où en est le dossier,
 * tout l'historique, les commentaires, le n° de dossier et la position relevée sur place.
 * Les colonnes de gauche sont faites pour être lues ; les colonnes masquées
 * servent à l'application, ne pas les modifier à la main.
 *
 * Copie versionnée du script du Google Sheet (Extensions > Apps Script).
 * Après modification : Déployer > Gérer les déploiements > crayon > Version : Nouvelle version > Déployer
 * (l'adresse /exec reste la même, pas besoin de changer SYNC_URL).
 */

const FEUILLE = "Suivi des biens";
const COLONNES = [
  "Bien", "Commune", "Confié à", "Où en est le dossier", "Dernier geste",
  "Modifié par", "Modifié le", "Annonce",
  "cle", "statut", "etape", "canal", "historique", "position", "supprime",
  "N° dossier", "Dernier commentaire", "commentaires"
];
/* Colonnes ajoutées après coup mais faites pour être lues : on ne les masque pas. */
const LISIBLES = ["N° dossier", "Dernier commentaire"];

function feuille_() {
  const classeur = SpreadsheetApp.getActiveSpreadsheet();
  let f = classeur.getSheetByName(FEUILLE);
  if (!f) {
    f = classeur.insertSheet(FEUILLE, 0);
    f.appendRow(COLONNES.filter(n => LISIBLES.indexOf(n) === -1));
    f.setFrozenRows(1);
    f.getRange(1, 1, 1, f.getLastColumn()).setFontWeight("bold").setBackground("#F2F2F7");
    f.setColumnWidth(1, 280); f.setColumnWidth(5, 320);
    f.hideColumns(9, f.getLastColumn() - 8);
  }
  const entete = f.getRange(1, 1, 1, f.getLastColumn()).getValues()[0];
  COLONNES.forEach(nom => {
    if (entete.indexOf(nom) === -1) {
      const n = f.getLastColumn() + 1;
      f.getRange(1, n).setValue(nom).setFontWeight("bold").setBackground("#F2F2F7");
      if (LISIBLES.indexOf(nom) === -1) f.hideColumns(n);
      else f.setColumnWidth(n, nom === "Dernier commentaire" ? 320 : 110);
      /* N° dossier en texte : garde les zéros de tête (« 0042 »). */
      if (nom === "N° dossier") f.getRange(1, n, f.getMaxRows(), 1).setNumberFormat("@");
      entete.push(nom);
    }
  });
  return f;
}

function reponse_(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet))
    .setMimeType(ContentService.MimeType.JSON);
}

function lire_(texte, defaut) {
  try { return texte ? JSON.parse(texte) : defaut; } catch (e) { return defaut; }
}

/* Lecture : toute l'équipe récupère l'état de chaque bien travaillé. */
function doGet() {
  const f = feuille_();
  const valeurs = f.getDataRange().getValues();
  const col = {}; valeurs[0].forEach((nom, i) => col[nom] = i);
  const rows = valeurs.slice(1).filter(r => r[col.cle]).map(r => ({
    cle: r[col.cle],
    assign: r[col["Confié à"]] || "",
    statut: r[col.statut] || "nouveau",
    reached: Number(r[col.etape]) || 0,
    canal: r[col.canal] || "",
    histo: lire_(r[col.historique], []),
    pin: lire_(r[col.position], null),
    supprime: lire_(r[col.supprime], null),
    comms: lire_(r[col.commentaires], []),
    dossier: String(r[col["N° dossier"]] || "")
  }));
  return reponse_({ ok: true, rows: rows });
}

/* Écriture : l'application envoie les biens modifiés, ligne créée ou mise à jour.
   Un champ absent de l'envoi (ancienne version de la page) garde sa valeur actuelle. */
function doPost(e) {
  const verrou = LockService.getScriptLock();
  verrou.waitLock(20000);
  try {
    const corps = JSON.parse(e.postData.contents);
    const f = feuille_();
    const valeurs = f.getDataRange().getValues();
    const col = {}; valeurs[0].forEach((nom, i) => col[nom] = i);
    const ligneDe = {};
    valeurs.forEach((r, i) => { if (i > 0 && r[col.cle]) ligneDe[r[col.cle]] = i + 1; });

    (corps.rows || []).forEach(x => {
      const avant = ligneDe[x.cle] ? valeurs[ligneDe[x.cle] - 1] : null;
      const ligne = avant ? avant.slice() : new Array(Object.keys(col).length).fill("");
      const pose = (nom, v) => { ligne[col[nom]] = v; };
      pose("Bien", x.titre || "");
      pose("Commune", x.commune || "");
      pose("Confié à", x.assign || "");
      pose("Où en est le dossier", x.statut_libelle || "");
      pose("Dernier geste", x.dernier_geste || "");
      pose("Modifié par", x.maj_par || "");
      pose("Modifié le", new Date(x.maj_le || Date.now()));
      pose("Annonce", x.lien || "");
      pose("cle", x.cle);
      pose("statut", x.statut || "nouveau");
      pose("etape", x.reached || 0);
      pose("canal", x.canal || "");
      pose("historique", JSON.stringify(x.histo || []));
      pose("position", x.pin ? JSON.stringify(x.pin) : "");
      pose("supprime", x.supprime ? JSON.stringify(x.supprime) : "");
      if (x.comms !== undefined) {
        pose("commentaires", x.comms.length ? JSON.stringify(x.comms) : "");
        pose("Dernier commentaire", x.dernier_commentaire || "");
      }
      if (x.dossier !== undefined) pose("N° dossier", String(x.dossier || ""));

      if (ligneDe[x.cle]) {
        f.getRange(ligneDe[x.cle], 1, 1, ligne.length).setValues([ligne]);
        valeurs[ligneDe[x.cle] - 1] = ligne;
      } else {
        f.appendRow(ligne);
        ligneDe[x.cle] = f.getLastRow();
        valeurs[ligneDe[x.cle] - 1] = ligne;
      }
    });
    return reponse_({ ok: true, enregistres: (corps.rows || []).length });
  } catch (err) {
    return reponse_({ ok: false, erreur: String(err) });
  } finally {
    verrou.releaseLock();
  }
}

/* À lancer une fois depuis l'éditeur : ajoute les nouvelles colonnes et autorise le script. */
function initialiser() {
  feuille_();
}
