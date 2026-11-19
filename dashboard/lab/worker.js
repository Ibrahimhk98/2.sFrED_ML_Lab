import { indexSession, waveform, uniformWindow, spectrum } from './signals.js';
import { trainRun, validateArtifact, inferWindow } from './pipeline.js';
import { evaluate } from './models.js';
import { exampleTrial } from './examples.js';
import { extractPreview, describePreview, plotColumns } from './feature-data.js';
import { LiveWindow } from './live.js';

const sources = new Map();
let trained = new Map(),
  previews = new Map(),
  loaded,
  live,
  liveModel;
function add(id, session, name, extra = {}) {
  if (sources.has(id)) throw new Error(name + ' is already in the dataset.');
  const source = indexSession(session);
  if (!source.available.length) throw new Error(name + ' contains no usable samples.');
  sources.set(id, source);
  return {
    id,
    name,
    channels: source.available,
    seconds: (source.bounds[1] - source.bounds[0]) / 1000,
    label: '',
    partition: 'train',
    ...extra
  };
}
async function readFile(file) {
  if (file.size > 192 * 1048576) throw new Error('File exceeds the 192 MiB import limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  if (sources.has(id)) throw new Error(file.name + ' is already in the dataset.');
  const h5 = await import('../vendor/h5wasm/hdf5_hl.js');
  const { readSession } = await import('../hdf5.js');
  return add(id, readSession(h5, (await h5.ready).FS, bytes), file.name);
}
function trace({ id, key, start, seconds, domain }) {
  const src = sources.get(id),
    a = src.bounds[0] + 1000 * start,
    b = a + 1000 * seconds;
  if (!src.available.includes(key)) return { points: [], note: 'Channel absent' };
  if (domain === 'time') return { points: waveform(src, key, a, b) };
  const signal = uniformWindow(src, key, a, b);
  const spec = signal && signal.observations >= 4 && spectrum(signal.values, signal.rate);
  if (!spec) return { points: [], note: 'FFT needs a continuous interval with at least four samples.' };
  const points = [],
    bucket = Math.max(1, Math.ceil(spec.amplitudes.length / 1000));
  for (let i = 0; i < spec.amplitudes.length; i += bucket) {
    let peak = i;
    for (let j = i + 1; j < Math.min(i + bucket, spec.amplitudes.length); j++)
      if (spec.amplitudes[j] > spec.amplitudes[peak]) peak = j;
    points.push([peak * spec.binHz, spec.amplitudes[peak]]);
  }
  return { points, nyquist: signal.rate / 2 };
}
function artifact(kind) {
  const selected = kind === 'loaded' ? loaded : trained.get(kind)?.artifact;
  if (!selected) throw new Error('Train a model or open a saved model first.');
  return selected;
}
function previewInfo(preview) {
  const { columns, files, audit, rows } = preview;
  return {
    columns,
    files,
    total: rows.length,
    trainingFiles: [...new Set(rows.map((r) => r.record))],
    skipped: audit.reduce((sum, r) => sum + r.skipped, 0)
  };
}
async function dispatch(action, payload) {
  switch (action) {
    case 'import':
      return readFile(payload.file);
    case 'examples':
      return Array.from({ length: 6 }, (_, i) => {
        const { session, name, ...meta } = exampleTrial(i);
        return add('example-' + i, session, name, meta);
      });
    case 'remove':
      sources.delete(payload.id);
      return;
    case 'trace':
      return payload.ids.map((id) => trace({ ...payload, id }));
    case 'preview': {
      const preview = extractPreview(
        payload.records.map((r) => ({ ...r, source: sources.get(r.id) })),
        payload.recipe
      );
      previews.set(payload.table, preview);
      return previewInfo(preview);
    }
    case 'columns': {
      const preview = previews.get(payload.table);
      if (!preview) throw new Error('Extract features first.');
      return plotColumns(preview, payload);
    }
    case 'train': {
      const artifacts = new Map(),
        tables = new Map(),
        summaries = [],
        cohorts = new Map();
      for (const group of payload.groups) {
        const { table, records, recipe, choices } = group;
        const run = trainRun(
          records.map((r) => ({ ...r, source: sources.get(r.id) })),
          recipe,
          choices,
          (message) => postMessage({ progress: message })
        );
        const preview = describePreview(
          records,
          recipe,
          run.trainingRows,
          run.audit.map((r) => ({ ...r, skipped: r.trainSkipped })),
          run.scale
        );
        tables.set(table, preview);
        // Only rank models together when they really saw the same held-out observations.
        const windowKey = (r) => [records[r.record].id, r.seconds, r.y];
        const signature = JSON.stringify([
          recipe.task,
          recipe.seconds,
          run.candidates[0].artifact.labels,
          run.validation.map(windowKey),
          run.test.map(windowKey)
        ]);
        if (!cohorts.has(signature)) cohorts.set(signature, cohorts.size);
        run.candidates.forEach((c, i) => {
          const { id } = choices[i];
          artifacts.set(id, { artifact: c.artifact, test: run.test });
          summaries.push({
            id,
            kind: c.kind,
            table,
            validation: c.validation,
            cohort: cohorts.get(signature),
            labels: c.artifact.labels,
            recipe,
            audit: run.audit
          });
        });
      }
      trained = artifacts;
      previews = tables;
      return {
        candidates: summaries,
        tables: Object.fromEntries([...tables].map(([key, p]) => [key, previewInfo(p)]))
      };
    }
    case 'invalidate':
      trained.clear();
      previews.clear();
      return;
    case 'test':
      return Object.fromEntries(
        payload.ids.map((id) => {
          const c = trained.get(id);
          if (!c) throw new Error('Train the pipeline before revealing test scores.');
          return [id, evaluate(c.artifact.model, c.test)];
        })
      );
    case 'export':
      return JSON.stringify(artifact(payload.kind));
    case 'load':
      loaded = validateArtifact(JSON.parse(await payload.file.text()));
      return { name: loaded.model.kind, recipe: loaded.recipe, labels: loaded.labels };
    case 'start':
      liveModel = artifact(payload.kind);
      live = new LiveWindow(liveModel.recipe);
      return {
        groups: live.groups,
        seconds: liveModel.recipe.seconds,
        hop: liveModel.recipe.seconds * (1 - liveModel.recipe.overlap / 100)
      };
    case 'stop':
      live = null;
      liveModel = null;
      return;
    case 'samples': {
      const window = live?.append(payload);
      if (window)
        postMessage({
          prediction: inferWindow(indexSession(window.session), window.start, liveModel),
          at: window.end
        });
      return;
    }
    default:
      throw new Error('Unknown lab action.');
  }
}
let pending = Promise.resolve();
self.onmessage = ({ data: { action, payload = {}, id } }) => {
  // Serialize HDF5's shared in-memory filesystem and model/dataset updates.
  pending = pending.then(async () => {
    try {
      const value = await dispatch(action, payload);
      if (id) postMessage({ id, value });
    } catch (error) {
      postMessage({ id, error: error.message });
    }
  });
};
