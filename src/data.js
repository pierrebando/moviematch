// Loads the static catalog built by scripts/build-data.mjs.
// URLs are resolved against this module, so the app works from any sub-path.

import { meanRating } from './scoring.js';

const MOVIES_URL = new URL('../data/movies.json', import.meta.url);
const EMBEDDINGS_URL = new URL('../data/embeddings.bin', import.meta.url);

async function fetchOk(url, as) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname} returned HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.arrayBuffer();
}

export async function loadData() {
  const [catalog, buffer] = await Promise.all([fetchOk(MOVIES_URL, 'json'), fetchOk(EMBEDDINGS_URL, 'binary')]);
  const { dim } = catalog.embedding;
  const vectors = new Int8Array(buffer);
  if (vectors.length !== catalog.movies.length * dim) {
    throw new Error(`embeddings.bin has ${vectors.length} values, expected ${catalog.movies.length} × ${dim}`);
  }

  // Int8 rounding slightly changes vector lengths, so keep exact norms for the cosine.
  const norms = new Float32Array(catalog.movies.length);
  for (let i = 0; i < norms.length; i++) {
    let sum = 0;
    for (let j = i * dim, end = j + dim; j < end; j++) sum += vectors[j] * vectors[j];
    norms[i] = Math.sqrt(sum) || 1;
  }

  return {
    ...catalog,
    meanRating: meanRating(catalog.movies),
    genreById: new Map(catalog.genres.map((g) => [g.id, g])),
    providerById: new Map(catalog.providers.map((p) => [p.id, p])),

    /** Cosine similarity of a normalized query vector with every movie, aligned with `movies`. */
    similarities(query) {
      const out = new Float32Array(norms.length);
      for (let i = 0; i < norms.length; i++) {
        let dot = 0;
        for (let j = 0, off = i * dim; j < dim; j++) dot += vectors[off + j] * query[j];
        out[i] = dot / norms[i];
      }
      return out;
    },
  };
}
