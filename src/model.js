// Lazy wrapper around transformers.js and the sentence-embedding model.
// Loads in the background; any failure just switches the app to genres only.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DTYPE = 'q8'; // quantized, same weights as the data build

let status = 'idle'; // idle | loading | ready | error
let progress = null; // 0-100 while downloading weights
let loading = null;
const listeners = new Set();
const cache = new Map(); // text -> Float32Array

function setStatus(next, nextProgress = null) {
  status = next;
  progress = nextProgress;
  for (const fn of listeners) fn({ status, progress });
}

export const getModelStatus = () => status;

/** Subscribes to status changes; calls fn immediately with the current state. */
export function onModelStatus(fn) {
  listeners.add(fn);
  fn({ status, progress });
  return () => listeners.delete(fn);
}

/** Starts loading once; resolves to the extractor, or null if loading failed. Call again after an error to retry. */
export function loadModel() {
  if (status === 'error') loading = null;
  if (loading) return loading;

  setStatus('loading');
  loading = (async () => {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false; // always fetch from the Hugging Face Hub (then browser cache)
    return pipeline('feature-extraction', MODEL_ID, {
      dtype: MODEL_DTYPE,
      progress_callback: (event) => {
        // The .onnx weights are ~95% of the download; the other files are tiny.
        if (event.status === 'progress' && event.file?.endsWith('.onnx')) {
          setStatus('loading', Math.round(event.progress));
        }
      },
    });
  })().then(
    (extractor) => {
      setStatus('ready');
      return extractor;
    },
    (err) => {
      console.warn('MovieMatch: AI model unavailable, falling back to genres only.', err);
      setStatus('error');
      return null;
    },
  );
  return loading;
}

/**
 * Embeds texts (mean pooling, normalized). Returns one Float32Array per text,
 * null for empty texts, or null overall if the model is unavailable.
 */
export async function embedTexts(texts) {
  const extractor = await loadModel();
  if (!extractor) return null;
  const todo = [...new Set(texts.filter((t) => t && !cache.has(t)))];
  if (todo.length) {
    const output = await extractor(todo, { pooling: 'mean', normalize: true });
    const dim = output.dims[1];
    todo.forEach((text, i) => cache.set(text, output.data.slice(i * dim, (i + 1) * dim)));
  }
  return texts.map((t) => (t ? cache.get(t) : null));
}
