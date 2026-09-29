const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Processor } = require('./lib/processor');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'radar-state.json');
const DESIGN_DIR = process.env.DESIGN_DIR || path.join(__dirname, '..', 'design');
const FINAL = new Set(['completed']);

function text(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function id() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function pagesBlanchesUrl(address) {
  return 'https://www.pagesjaunes.fr/pagesblanches/recherche?' + new URLSearchParams({ quoiqui: '', ou: address, univers: 'pagesblanches', idOu: '' });
}
function normalizeResult(result = {}) {
  return {
    fullName: text(result.fullName), lastName: text(result.lastName), firstName: text(result.firstName),
    phone: text(result.phone), address: text(result.address), capturedAt: result.capturedAt || new Date().toISOString()
  };
}
function resultKey(result) {
  const phone = text(result.phone).replace(/\D+/g, '');
  return phone ? `phone:${phone}` : `${text(result.fullName).toLowerCase()}|${text(result.address).toLowerCase()}`;
}

let state = { jobs: [] };
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && Array.isArray(saved.jobs)) state = saved;
  }
} catch (error) {
  throw new Error(`Les données Radar sont illisibles et n’ont pas été écrasées : ${error.message}`);
}
for (const job of state.jobs) {
  job.results = Array.isArray(job.results) ? job.results.map(normalizeResult) : [];
  if (job.status === 'running' || job.status === 'queued') {
    job.status = 'paused';
    job.message = 'Recherche interrompue. Cliquez sur Réessayer pour la reprendre.';
  }
}
function save() {
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_FILE);
}
function publicJob(job) {
  return {
    id: job.id, reference: job.reference, address: job.address, status: job.status,
    message: job.message || '', progress: FINAL.has(job.status) ? 100 : 0,
    createdAt: job.createdAt, completedAt: job.completedAt || null,
    results: job.results.map(({ fullName, lastName, firstName, phone, address }) => ({ fullName, lastName, firstName, phone, address }))
  };
}

let runningJob = null;
let waitingJob = null;
let running = false;
const processor = new Processor({
  profileDir: process.env.PB_PROFILE_DIR || path.join(__dirname, '.browser-profile'),
  onProgress(message) {
    if (runningJob) { runningJob.message = message; save(); }
  },
  onResult(incoming) {
    if (!runningJob) return;
    const result = normalizeResult(incoming);
    if (!result.fullName && !result.phone && !result.address) return;
    const key = resultKey(result);
    const existing = runningJob.results.findIndex(item => resultKey(item) === key);
    if (existing >= 0) runningJob.results[existing] = { ...runningJob.results[existing], ...result };
    else runningJob.results.push(result);
    save();
  }
});

function queue(job) {
  job.status = 'queued';
  job.message = 'En attente de démarrage';
  delete job.stopRequested;
  save();
  setImmediate(runQueue);
}
async function runQueue() {
  if (running || waitingJob) return;
  const job = state.jobs.find(item => item.status === 'queued');
  if (!job) return;
  running = true;
  runningJob = job;
  job.status = 'running';
  job.message = 'Préparation de la recherche';
  save();
  try {
    await processor.collect({ id: job.id, sourceUrl: pagesBlanchesUrl(job.address) }, () => job.status !== 'running', { visible: job.browserMode === 'visible' });
    if (job.status === 'running') {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.message = 'Recherche terminée';
    }
  } catch (error) {
    job.status = 'paused';
    job.message = error.message === 'PAUSED' ? 'Recherche arrêtée. Cliquez sur Réessayer pour la reprendre.' : error.message;
    if (error.code === 'VERIFICATION_REQUIRED') {
      job.browserMode = 'visible';
      waitingJob = job.id;
    }
  } finally {
    save();
    if (waitingJob !== job.id) await processor.close();
    runningJob = null;
    running = false;
    setImmediate(runQueue);
  }
}

app.use(express.json({ limit: '64kb' }));
app.post('/api/radar/lookups', (req, res) => {
  const address = text(req.body.address);
  if (!address) return res.status(400).json({ error: 'Adresse requise.' });
  const job = { id: id(), reference: text(req.body.reference), address, status: 'queued', message: '', results: [], createdAt: new Date().toISOString() };
  state.jobs.push(job);
  queue(job);
  res.status(202).json(publicJob(job));
});
app.get('/api/radar/lookups/:id', (req, res) => {
  const job = state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Recherche introuvable.' });
  res.json(publicJob(job));
});
app.post('/api/radar/lookups/:id/resume', async (req, res) => {
  const job = state.jobs.find(item => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Recherche introuvable.' });
  if (job.status === 'completed') return res.json(publicJob(job));
  if (runningJob && runningJob.id === job.id) return res.status(409).json({ error: 'La recherche est déjà en cours.' });
  if (waitingJob === job.id) waitingJob = null;
  queue(job);
  res.json(publicJob(job));
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', searches: state.jobs.length }));
// La page servie est celle du dossier design/ du dépôt (avec ban/ et bat/).
app.use(express.static(DESIGN_DIR));

const server = app.listen(PORT, '127.0.0.1', error => {
  if (error) {
    if (error.code === 'EADDRINUSE') console.error(`Le port ${PORT} est déjà utilisé. Fermez l’autre instance de Radar Mandats, puis relancez npm start.`);
    else console.error(`Impossible de démarrer Radar Mandats : ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Radar Mandats : http://localhost:${server.address().port}`);
});
async function shutdown() {
  if (runningJob) { runningJob.status = 'paused'; runningJob.message = 'Recherche interrompue. Cliquez sur Réessayer pour la reprendre.'; save(); }
  await processor.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
