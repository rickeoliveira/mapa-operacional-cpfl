import http from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.dirname(fileURLToPath(import.meta.url));
function loadEnv(file) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
loadEnv(path.join(root, '..', '.env'));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.CPFL_MAP_PORT || 2223);
let lastTelemetryCleanup = 0;
const assetFiles = {
  'ed_capacitor.txt': { type: 'Capacitor', width: 4 },
  'ed_fuse.txt': { type: 'Fusível', width: 6 },
  'ed_oh_transformer.txt': { type: 'Transformador', width: 4 },
  'ed_recloser.txt': { type: 'Religador', width: 6 },
  'ed_regulator.txt': { type: 'Regulador', width: 6 },
  'ed_switch.txt': { type: 'Chave', width: 6 },
  'ed_ug_switch.txt': { type: 'Chave', width: 6 },
};
const feederFile = 'ed_oh_primary_conductor.txt';
const geocodeCache = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function text(res, status, data) {
  res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}
function noContent(res) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); }
function readJson(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Corpo da requisição muito grande.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });
}
async function initializeTelemetry() {
  await db.query(`CREATE TABLE IF NOT EXISTS cpfl_access_sessions (
    session_id UUID PRIMARY KEY,
    visitor_id UUID NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS cpfl_access_daily_visitors (
    day DATE NOT NULL,
    visitor_id UUID NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, visitor_id)
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_access_sessions_last_seen_idx ON cpfl_access_sessions(last_seen)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_access_daily_visitors_last_seen_idx ON cpfl_access_daily_visitors(last_seen)');
}
const telemetryReady = initializeTelemetry();
function isTelemetryId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
async function recordHeartbeat(sessionId, visitorId) {
  await telemetryReady;
  await db.query(`INSERT INTO cpfl_access_sessions(session_id, visitor_id)
    VALUES ($1, $2)
    ON CONFLICT (session_id) DO UPDATE SET visitor_id = EXCLUDED.visitor_id, last_seen = NOW()`, [sessionId, visitorId]);
  await db.query(`INSERT INTO cpfl_access_daily_visitors(day, visitor_id)
    VALUES ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, $1)
    ON CONFLICT (day, visitor_id) DO UPDATE SET last_seen = NOW()`, [visitorId]);
  if (Date.now() - lastTelemetryCleanup > 60 * 60 * 1000) {
    lastTelemetryCleanup = Date.now();
    await db.query(`DELETE FROM cpfl_access_sessions WHERE last_seen < NOW() - INTERVAL '7 days'`);
  }
}
async function telemetryMetrics() {
  await telemetryReady;
  const result = await db.query(`SELECT
    COUNT(*) FILTER (WHERE s.last_seen > NOW() - INTERVAL '90 seconds')::int AS concurrent,
    COUNT(DISTINCT d.visitor_id) FILTER (WHERE d.day = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS day,
    COUNT(DISTINCT d.visitor_id) FILTER (WHERE date_trunc('month', d.day) = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS month,
    COUNT(DISTINCT d.visitor_id) FILTER (WHERE date_trunc('year', d.day) = date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS year
    FROM cpfl_access_sessions s FULL OUTER JOIN cpfl_access_daily_visitors d USING (visitor_id)`);
  const row = result.rows[0];
  return [
    '# HELP cpfl_map_accesses_concurrent Sessões com atividade nos últimos 90 segundos.',
    '# TYPE cpfl_map_accesses_concurrent gauge',
    `cpfl_map_accesses_concurrent ${row.concurrent || 0}`,
    '# HELP cpfl_map_unique_visitors Visitantes únicos do Mapa CPFL.',
    '# TYPE cpfl_map_unique_visitors gauge',
    `cpfl_map_unique_visitors{period="day"} ${row.day || 0}`,
    `cpfl_map_unique_visitors{period="month"} ${row.month || 0}`,
    `cpfl_map_unique_visitors{period="year"} ${row.year || 0}`
  ].join('\n') + '\n';
}
function valid(lon, lat) { return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -75 && lon <= -30 && lat >= -35 && lat <= -5; }
function parseAsset(fields, type, source) {
  const feeder = fields[0]?.trim();
  const operationalNumber = fields[1]?.trim();
  const lon1 = Number(fields[2]), lat1 = Number(fields[3]);
  if (!feeder || !operationalNumber || !valid(lon1, lat1)) return null;
  const lon2 = fields.length >= 6 ? Number(fields[4]) : null;
  const lat2 = fields.length >= 6 ? Number(fields[5]) : null;
  const longitude = valid(lon2, lat2) ? (lon1 + lon2) / 2 : lon1;
  const latitude = valid(lon2, lat2) ? (lat1 + lat2) / 2 : lat1;
  return [type, feeder, operationalNumber, longitude, latitude, source];
}
async function insertBatch(rows) {
  if (!rows.length) return;
  const values = [], params = [];
  for (const row of rows) {
    const start = params.length + 1;
    values.push(`($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`);
    params.push(...row);
  }
  await db.query(`INSERT INTO cpfl_assets(asset_type, feeder, operational_number, longitude, latitude, source_file) VALUES ${values.join(',')}`, params);
}
async function insertSegmentBatch(rows) {
  if (!rows.length) return;
  const values = [], params = [];
  for (const row of rows) {
    const start = params.length + 1;
    values.push(`($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`);
    params.push(...row);
  }
  await db.query(`INSERT INTO cpfl_feeder_segments(feeder, longitude_from, latitude_from, longitude_to, latitude_to, source_file) VALUES ${values.join(',')}`, params);
}
function splitPipe(line) {
  const values = line.replace(/\r$/, '').split('|');
  if (values.at(-1) === '') values.pop();
  return values;
}
function parseSegment(fields, source) {
  const feeder = fields[0]?.trim();
  const longitudeFrom = Number(fields[1]), latitudeFrom = Number(fields[2]);
  const longitudeTo = Number(fields[3]), latitudeTo = Number(fields[4]);
  if (!feeder || !valid(longitudeFrom, latitudeFrom) || !valid(longitudeTo, latitudeTo)) return null;
  return [feeder, longitudeFrom, latitudeFrom, longitudeTo, latitudeTo, source];
}
async function importData(dataDir) {
  await db.query(`CREATE TABLE IF NOT EXISTS cpfl_assets (
    id BIGSERIAL PRIMARY KEY,
    asset_type TEXT NOT NULL,
    feeder TEXT NOT NULL,
    operational_number TEXT NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    source_file TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS cpfl_feeder_segments (
    id BIGSERIAL PRIMARY KEY,
    feeder TEXT NOT NULL,
    longitude_from DOUBLE PRECISION NOT NULL,
    latitude_from DOUBLE PRECISION NOT NULL,
    longitude_to DOUBLE PRECISION NOT NULL,
    latitude_to DOUBLE PRECISION NOT NULL,
    source_file TEXT NOT NULL
  )`);
  await db.query('TRUNCATE cpfl_assets, cpfl_feeder_segments RESTART IDENTITY');
  let assetTotal = 0, segmentTotal = 0;
  for (let folder = 1; folder <= 15; folder += 1) {
    const folderPath = path.join(dataDir, String(folder));
    if (!existsSync(folderPath)) continue;
    for (const [file, definition] of Object.entries(assetFiles)) {
      const filePath = path.join(folderPath, file);
      if (!existsSync(filePath)) continue;
      let batch = [];
      const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
      let isHeader = true;
      for await (const line of lines) {
        if (isHeader) { isHeader = false; continue; }
        const row = parseAsset(splitPipe(line).slice(0, definition.width), definition.type, `${folder}/${file}`);
        if (row) batch.push(row);
        if (batch.length >= 2000) { await insertBatch(batch); assetTotal += batch.length; batch = []; }
      }
      await insertBatch(batch); assetTotal += batch.length;
    }
    const feederPath = path.join(folderPath, feederFile);
    if (!existsSync(feederPath)) continue;
    let segmentBatch = [];
    const feederLines = createInterface({ input: createReadStream(feederPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    let isHeader = true;
    for await (const line of feederLines) {
      if (isHeader) { isHeader = false; continue; }
      const row = parseSegment(splitPipe(line), `${folder}/${feederFile}`);
      if (row) segmentBatch.push(row);
      if (segmentBatch.length >= 5000) { await insertSegmentBatch(segmentBatch); segmentTotal += segmentBatch.length; segmentBatch = []; }
    }
    await insertSegmentBatch(segmentBatch); segmentTotal += segmentBatch.length;
  }
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_location_idx ON cpfl_assets(longitude, latitude)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_number_idx ON cpfl_assets(operational_number text_pattern_ops)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_type_idx ON cpfl_assets(asset_type)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_feeder_segments_bounds_idx ON cpfl_feeder_segments(longitude_from, latitude_from)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_feeder_segments_feeder_idx ON cpfl_feeder_segments(feeder)');
  console.log(`Importação concluída: ${assetTotal} ativos e ${segmentTotal} trechos de rede.`);
}

async function api(req, res, url) {
  if (url.pathname === '/api/telemetry/heartbeat' && req.method === 'POST') {
    const { sessionId, visitorId } = await readJson(req);
    if (!isTelemetryId(sessionId) || !isTelemetryId(visitorId)) return json(res, 422, { error: 'Identificador de telemetria inválido.' });
    await recordHeartbeat(sessionId, visitorId);
    return noContent(res);
  }
  if (url.pathname === '/api/types') {
    const result = await db.query('SELECT asset_type, count(*)::int AS count FROM cpfl_assets GROUP BY asset_type ORDER BY asset_type');
    return json(res, 200, result.rows);
  }
  if (url.pathname === '/api/feeders') {
    const result = await db.query(`SELECT feeder, sum(asset_count)::int AS asset_count, sum(segment_count)::int AS segment_count
      FROM (
        SELECT feeder, count(*)::int AS asset_count, 0 AS segment_count FROM cpfl_assets GROUP BY feeder
        UNION ALL
        SELECT feeder, 0 AS asset_count, count(*)::int AS segment_count FROM cpfl_feeder_segments GROUP BY feeder
      ) totals GROUP BY feeder ORDER BY feeder`);
    return json(res, 200, result.rows);
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(res, 200, []);
    const result = await db.query(`SELECT id, asset_type, feeder, operational_number, longitude, latitude
      FROM cpfl_assets WHERE operational_number = $1 OR operational_number ILIKE $2
      ORDER BY CASE WHEN operational_number = $1 THEN 0 ELSE 1 END, asset_type LIMIT 50`, [q, `${q}%`]);
    return json(res, 200, result.rows);
  }
  if (url.pathname === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 3) return json(res, 200, []);
    const key = q.toLocaleLowerCase('pt-BR');
    const cached = geocodeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return json(res, 200, cached.items);
    const endpoint = new URL('https://nominatim.openstreetmap.org/search');
    endpoint.search = new URLSearchParams({ q: `${q}, Brasil`, format: 'jsonv2', limit: '5', countrycodes: 'br', addressdetails: '1' });
    const response = await fetch(endpoint, { headers: { 'user-agent': 'Mapa Operacional CPFL/1.0' } });
    if (!response.ok) return json(res, 502, { error: 'Não foi possível localizar a rua agora.' });
    const raw = await response.json();
    const items = raw.map(item => ({ name: item.display_name, latitude: Number(item.lat), longitude: Number(item.lon), kind: 'street' }))
      .filter(item => valid(item.longitude, item.latitude));
    geocodeCache.set(key, { items, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return json(res, 200, items);
  }
  if (url.pathname === '/api/assets') {
    const west = Number(url.searchParams.get('west')), east = Number(url.searchParams.get('east'));
    const south = Number(url.searchParams.get('south')), north = Number(url.searchParams.get('north'));
    const requestedTypes = (url.searchParams.get('types') || '').split(',').filter(Boolean);
    const requestedFeeders = (url.searchParams.get('feeders') || '').split(',').filter(Boolean);
    if (![west, east, south, north].every(Number.isFinite) || west >= east || south >= north) return json(res, 422, { error: 'Área inválida.' });
    const limit = Math.max(500, Math.min(Number(url.searchParams.get('limit')) || 5000, 8000));
    const params = [west, east, south, north];
    let where = 'longitude BETWEEN $1 AND $2 AND latitude BETWEEN $3 AND $4';
    if (requestedTypes.length) { params.push(requestedTypes); where += ` AND asset_type = ANY($${params.length})`; }
    if (requestedFeeders.length) { params.push(requestedFeeders); where += ` AND feeder = ANY($${params.length})`; }
    params.push(limit + 1);
    const result = await db.query(`SELECT id, asset_type, feeder, operational_number, longitude, latitude FROM cpfl_assets WHERE ${where} ORDER BY id LIMIT $${params.length}`, params);
    const truncated = result.rows.length > limit;
    return json(res, 200, { items: truncated ? result.rows.slice(0, limit) : result.rows, truncated });
  }
  if (url.pathname === '/api/network') {
    const west = Number(url.searchParams.get('west')), east = Number(url.searchParams.get('east'));
    const south = Number(url.searchParams.get('south')), north = Number(url.searchParams.get('north'));
    const requestedFeeders = (url.searchParams.get('feeders') || '').split(',').filter(Boolean);
    if (![west, east, south, north].every(Number.isFinite) || west >= east || south >= north) return json(res, 422, { error: 'Área inválida.' });
    const limit = Math.max(1000, Math.min(Number(url.searchParams.get('limit')) || 12000, 20000));
    const params = [west, east, south, north];
    let where = '((longitude_from BETWEEN $1 AND $2 AND latitude_from BETWEEN $3 AND $4) OR (longitude_to BETWEEN $1 AND $2 AND latitude_to BETWEEN $3 AND $4))';
    if (requestedFeeders.length) { params.push(requestedFeeders); where += ` AND feeder = ANY($${params.length})`; }
    params.push(limit + 1);
    const result = await db.query(`SELECT feeder, longitude_from, latitude_from, longitude_to, latitude_to
      FROM cpfl_feeder_segments WHERE ${where} ORDER BY id LIMIT $${params.length}`, params);
    const truncated = result.rows.length > limit;
    return json(res, 200, { items: truncated ? result.rows.slice(0, limit) : result.rows, truncated });
  }
  return json(res, 404, { error: 'Não encontrado.' });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/metrics') return text(res, 200, await telemetryMetrics());
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const safe = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
    const file = path.join(root, safe);
    if (!file.startsWith(path.join(root, 'public'))) return res.writeHead(403).end();
    const body = await readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); json(res, 500, { error: 'Erro interno.' }); }
});
if (process.argv[2] === 'import') await importData(process.argv[3] || path.join(root, 'data'));
else server.listen(PORT, () => console.log(`Mapa CPFL disponível na porta ${PORT}`));
