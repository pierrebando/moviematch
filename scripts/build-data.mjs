#!/usr/bin/env node
// MovieMatch data build.
//
// Fetches recent, well-known movies from TMDB (with their French streaming
// providers), embeds "title. overview" with a Hugging Face sentence model and
// writes the static files the web app loads:
//   data/movies.json     movies + genres + providers + embedding metadata
//   data/embeddings.bin  one Int8 vector per movie, same order as movies.json
//
// Usage:
//   node scripts/build-data.mjs              full build (every match, up to MAX_MOVIES)
//   node scripts/build-data.mjs --sample 50  quick validation run
//   node scripts/build-data.mjs --no-cache   ignore cached TMDB responses
//
// Needs TMDB_TOKEN in .env (TMDB "API Read Access Token"). The token is only
// used here and never written to data/.

import fs from 'node:fs/promises';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');

const API_BASE = 'https://api.themoviedb.org/3';
const LANGUAGE = 'en-US';
const REGION = 'FR';
const RELEASED_FROM = '2022-01-01';
const MIN_VOTE_COUNT = 200;
const MAX_MOVIES = 2500; // safety cap, above the ~1,700 movies that match today
const DISCOVER_PAGE_SIZE = 20;
const DISCOVER_MAX_PAGES = 500; // TMDB hard limit

const CONCURRENCY = 8;
const MAX_RETRIES = 6;
const CACHE_MAX_AGE_DAYS = 7; // providers change over time, so the cache expires

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DTYPE = 'q8'; // same quantized weights as the browser, same vector space
const EMBED_BATCH_SIZE = 32;
const INT8_SCALE = 127;

const PAYLOAD_BUDGET_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { sample: null, cache: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sample' || arg.startsWith('--sample=')) {
      const raw = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) fail(`--sample expects a positive number, got "${raw}"`);
      args.sample = n;
    } else if (arg === '--no-cache') {
      args.cache = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/build-data.mjs [--sample N] [--no-cache]');
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- .env

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    if (!(key in process.env)) process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------- TMDB client

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;

function createTmdbClient(token, { useCache }) {
  // Accept the v3 API key too (32 hex chars), even though the read-access token is preferred.
  const isV3Key = /^[0-9a-f]{32}$/i.test(token);
  const headers = { accept: 'application/json' };
  if (!isV3Key) headers.authorization = `Bearer ${token}`;
  const stats = { network: 0, cached: 0, retries: 0 };
  mkdirSync(CACHE_DIR, { recursive: true });

  function cacheFile(key) {
    return path.join(CACHE_DIR, `${key.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 200)}.json`);
  }

  function isFresh(file) {
    if (!useCache || !existsSync(file)) return false;
    const ageDays = (Date.now() - statSync(file).mtimeMs) / 86_400_000;
    return ageDays < CACHE_MAX_AGE_DAYS;
  }

  async function get(pathname, params = {}, cacheKey) {
    const query = new URLSearchParams({ language: LANGUAGE, ...params });
    const key = cacheKey ?? `${pathname}?${query}`;
    const file = cacheFile(key);
    if (isFresh(file)) {
      stats.cached++;
      return JSON.parse(await fs.readFile(file, 'utf8'));
    }

    if (isV3Key) query.set('api_key', token);
    const url = `${API_BASE}${pathname}?${query}`;

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw new Error(`Network error on ${pathname}: ${err.message}`);
        stats.retries++;
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        const json = await res.json();
        await fs.writeFile(file, JSON.stringify(json));
        stats.network++;
        return json;
      }
      if (res.status === 401) fail('TMDB rejected the token (401). Check TMDB_TOKEN in .env.');
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        stats.retries++;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw new Error(`TMDB ${res.status} on ${pathname}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  return { get, stats };
}

// Runs fn over items with at most `limit` calls in flight, keeping input order.
async function mapPool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function progress(label) {
  let lastPrinted = -1;
  return (done, total) => {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${label}: ${done}/${total}`);
      if (done === total) process.stdout.write('\n');
    } else {
      const step = Math.floor((done / total) * 10);
      if (step !== lastPrinted || done === total) {
        lastPrinted = step;
        console.log(`  ${label}: ${done}/${total}`);
      }
    }
  };
}

// ---------------------------------------------------------------- steps

async function fetchMovieIds(tmdb, target) {
  const today = new Date().toISOString().slice(0, 10);
  const params = (page) => ({
    'primary_release_date.gte': RELEASED_FROM,
    'primary_release_date.lte': today,
    'vote_count.gte': MIN_VOTE_COUNT,
    include_adult: 'false',
    include_video: 'false',
    sort_by: 'vote_count.desc',
    page,
  });

  const first = await tmdb.get('/discover/movie', params(1));
  const pages = Math.min(first.total_pages, DISCOVER_MAX_PAGES, Math.ceil(target / DISCOVER_PAGE_SIZE));
  console.log(`  ${first.total_results} movies match on TMDB, reading ${pages} page(s)`);

  const rest = await mapPool(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
    CONCURRENCY,
    (page) => tmdb.get('/discover/movie', params(page)),
    pages > 1 ? progress('discover pages') : undefined,
  );

  const seen = new Set();
  const ids = [];
  for (const page of [first, ...rest]) {
    for (const movie of page?.results ?? []) {
      if (!seen.has(movie.id)) {
        seen.add(movie.id);
        ids.push(movie.id);
      }
    }
  }
  return ids.slice(0, target);
}

// Folds "X with Ads" / "X Standard with Ads" into "X" when X is also present.
function mergeAdTiers(providers) {
  const byName = new Map([...providers.values()].map((p) => [p.name.toLowerCase(), p.id]));
  const alias = new Map();
  for (const p of providers.values()) {
    const base = p.name.match(/^(.*?)\s+(?:(?:standard|basic)\s+)?with\s+ads$/i)?.[1];
    const baseId = base && byName.get(base.toLowerCase());
    if (baseId && baseId !== p.id) alias.set(p.id, baseId);
  }
  return alias;
}

function toMovie(details) {
  const flatrate = details['watch/providers']?.results?.[REGION]?.flatrate ?? [];
  return {
    id: details.id,
    title: details.title,
    year: Number.parseInt(details.release_date?.slice(0, 4), 10) || null,
    runtime: details.runtime,
    genres: (details.genres ?? []).map((g) => g.id),
    overview: (details.overview ?? '').trim(),
    poster: details.poster_path ?? null,
    rating: Math.round((details.vote_average ?? 0) * 100) / 100,
    votes: details.vote_count ?? 0,
    providers: flatrate.map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path ?? null })),
  };
}

function buildCatalog(detailsList, genreList) {
  const movies = [];
  let skipped = 0;
  for (const details of detailsList) {
    if (!details || !details.runtime) {
      skipped++;
      continue;
    }
    movies.push(toMovie(details));
  }

  const providers = new Map();
  for (const movie of movies) {
    for (const p of movie.providers) {
      if (!providers.has(p.id)) providers.set(p.id, { id: p.id, name: p.name, logo: p.logo, count: 0 });
    }
  }
  const alias = mergeAdTiers(providers);
  for (const movie of movies) {
    movie.providers = [...new Set(movie.providers.map((p) => alias.get(p.id) ?? p.id))];
    for (const id of movie.providers) providers.get(id).count++;
  }
  for (const id of alias.keys()) providers.delete(id);

  const genreCounts = new Map();
  for (const movie of movies) for (const id of movie.genres) genreCounts.set(id, (genreCounts.get(id) ?? 0) + 1);
  const genres = genreList
    .map((g) => ({ id: g.id, name: g.name, count: genreCounts.get(g.id) ?? 0 }))
    .filter((g) => g.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    movies,
    skipped,
    genres,
    providers: [...providers.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

async function loadExtractor() {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    fail('Missing dependency @huggingface/transformers. Run "npm install" first.');
  }
  transformers.env.cacheDir = path.join(CACHE_DIR, 'models');
  return transformers.pipeline('feature-extraction', MODEL_ID, { dtype: MODEL_DTYPE });
}

async function embedMovies(extractor, movies) {
  let dim = 0;
  let vectors = null;
  const report = progress('embeddings');
  for (let start = 0; start < movies.length; start += EMBED_BATCH_SIZE) {
    const batch = movies.slice(start, start + EMBED_BATCH_SIZE);
    const texts = batch.map((m) => (m.overview ? `${m.title}. ${m.overview}` : m.title));
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    if (!vectors) {
      dim = output.dims[1];
      vectors = new Int8Array(movies.length * dim);
    }
    const values = output.data;
    for (let i = 0; i < values.length; i++) {
      vectors[start * dim + i] = Math.max(-INT8_SCALE, Math.min(INT8_SCALE, Math.round(values[i] * INT8_SCALE)));
    }
    report(Math.min(start + EMBED_BATCH_SIZE, movies.length), movies.length);
  }
  return { dim, vectors };
}

// Embeds a sample query and prints the closest movies, as a quick sanity check.
async function sanityCheck(extractor, movies, vectors, dim) {
  const query = 'a tense survival story';
  const q = (await extractor([query], { pooling: 'mean', normalize: true })).data;
  const scored = movies.map((movie, i) => {
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += vectors[i * dim + j] * q[j];
    return { title: movie.title, score: dot / INT8_SCALE };
  });
  scored.sort((a, b) => b.score - a.score);
  console.log(`  closest to "${query}":`);
  for (const { title, score } of scored.slice(0, 3)) console.log(`    ${score.toFixed(3)}  ${title}`);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const token = process.env.TMDB_TOKEN?.trim();
  if (!token) fail('TMDB_TOKEN is missing. Copy .env.example to .env and paste your TMDB read-access token.');

  const target = args.sample ?? MAX_MOVIES;
  const startedAt = Date.now();
  const tmdb = createTmdbClient(token, { useCache: args.cache });
  console.log(`MovieMatch data build — ${args.sample ? `sample of ${target}` : `up to ${target}`} movies\n`);

  console.log('1/4 Genres');
  const genreList = (await tmdb.get('/genre/movie/list')).genres;
  console.log(`  ${genreList.length} genres`);

  console.log(`2/4 Movies released since ${RELEASED_FROM} with ≥ ${MIN_VOTE_COUNT} votes`);
  const ids = await fetchMovieIds(tmdb, target);
  const detailsList = await mapPool(
    ids,
    CONCURRENCY,
    (id) => tmdb.get(`/movie/${id}`, { append_to_response: 'watch/providers' }, `movie_${id}_${LANGUAGE}`),
    progress('movie details'),
  );
  const catalog = buildCatalog(detailsList, genreList);
  console.log(
    `  kept ${catalog.movies.length} movies (${catalog.skipped} skipped without runtime), ` +
      `${catalog.providers.length} ${REGION} streaming providers`,
  );
  console.log(`  TMDB requests: ${tmdb.stats.network} network, ${tmdb.stats.cached} from cache, ${tmdb.stats.retries} retries`);
  if (catalog.movies.length === 0) fail('No movies left, nothing to write.');

  console.log(`3/4 Embeddings with ${MODEL_ID} (${MODEL_DTYPE})`);
  const extractor = await loadExtractor();
  const { dim, vectors } = await embedMovies(extractor, catalog.movies);
  await sanityCheck(extractor, catalog.movies, vectors, dim);

  console.log('4/4 Writing data/');
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    region: REGION,
    releasedFrom: RELEASED_FROM,
    minVoteCount: MIN_VOTE_COUNT,
    sample: args.sample !== null,
    embedding: { model: MODEL_ID, dtype: MODEL_DTYPE, dim, scale: INT8_SCALE, file: 'embeddings.bin' },
    count: catalog.movies.length,
    genres: catalog.genres,
    providers: catalog.providers,
    movies: catalog.movies,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const jsonPath = path.join(DATA_DIR, 'movies.json');
  const binPath = path.join(DATA_DIR, 'embeddings.bin');
  await fs.writeFile(jsonPath, JSON.stringify(output));
  await fs.writeFile(binPath, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));

  const jsonSize = (await fs.stat(jsonPath)).size;
  const binSize = (await fs.stat(binPath)).size;
  const total = jsonSize + binSize;
  console.log('\nSummary');
  console.log(`  movies          ${catalog.movies.length}`);
  console.log(`  genres          ${catalog.genres.length}`);
  console.log(`  providers (${REGION})  ${catalog.providers.length}`);
  console.log(`  movies.json     ${kb(jsonSize)}`);
  console.log(`  embeddings.bin  ${kb(binSize)}  (${catalog.movies.length} × ${dim} int8)`);
  console.log(`  total payload   ${kb(total)}${total > PAYLOAD_BUDGET_BYTES ? '  ⚠ above the 3 MB budget' : ''}`);
  console.log(`  done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  if (args.sample) console.log('\n⚠ Sample data written to data/. Run "npm run build:data" without --sample before committing.');
}

main().catch((err) => fail(err.stack ?? String(err)));
