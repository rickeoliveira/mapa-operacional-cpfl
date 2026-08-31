import http from 'node:http';
import { readFileSync, createReadStream } from 'node:fs';
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
const types = {
  'ed_capacitor.csv': 'Capacitor',
  'ed_fuse.csv': 'Fusível',
  'ed_oh_transformer.csv': 'Transformador',
  'ed_recloser.csv': 'Religador',
  'ed_regulator.csv': 'Regulador',
  'ed_switch.csv': 'Chave',
};

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
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
async function importCsv(dataDir) {
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
  await db.query('TRUNCATE cpfl_assets');
  let total = 0;
  for (const [file, type] of Object.entries(types)) {
    let batch = [];
    const lines = createInterface({ input: createReadStream(path.join(dataDir, file), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const fields = line.replace(/\r$/, '').split(',').filter((value, index, array) => !(index === array.length - 1 && value === ''));
      const width = file === 'ed_capacitor.csv' || file === 'ed_oh_transformer.csv' ? 4 : 6;
      for (let start = 0; start + width <= fields.length; start += width) {
        const row = parseAsset(fields.slice(start, start + width), type, file);
        if (row) batch.push(row);
      }
      if (batch.length >= 2000) { await insertBatch(batch); total += batch.length; batch = []; }
    }
    await insertBatch(batch); total += batch.length;
  }
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_location_idx ON cpfl_assets(longitude, latitude)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_number_idx ON cpfl_assets(operational_number text_pattern_ops)');
  await db.query('CREATE INDEX IF NOT EXISTS cpfl_assets_type_idx ON cpfl_assets(asset_type)');
  console.log(`Importação concluída: ${total} ativos.`);
}

async function api(req, res, url) {
  if (url.pathname === '/api/types') {
    const result = await db.query('SELECT asset_type, count(*)::int AS count FROM cpfl_assets GROUP BY asset_type ORDER BY asset_type');
    return json(res, 200, result.rows);
  }
  if (url.pathname === '/api/feeders') {
    const result = await db.query('SELECT feeder, count(*)::int AS count FROM cpfl_assets GROUP BY feeder ORDER BY feeder');
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
  return json(res, 404, { error: 'Não encontrado.' });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const safe = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
    const file = path.join(root, safe);
    if (!file.startsWith(path.join(root, 'public'))) return res.writeHead(403).end();
    const body = await readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(body);
  } catch (error) { console.error(error); json(res, 500, { error: 'Erro interno.' }); }
});
if (process.argv[2] === 'import') await importCsv(process.argv[3] || path.join(root, 'data'));
else server.listen(PORT, () => console.log(`Mapa CPFL disponível na porta ${PORT}`));
