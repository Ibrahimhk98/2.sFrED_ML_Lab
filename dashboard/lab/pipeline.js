import { channels, features, models } from './catalog.js';
import { featureRow } from './signals.js';
import { fitScale, transform, fitModel, evaluate, predict } from './models.js';

export const partitions = ['train', 'validation', 'test'];
const modes = ['classification', 'regression'];
const insist = (ok, message) => {
  if (!ok) throw new Error(message);
};
const between = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const uniqueKeys = (list, valid) =>
  Array.isArray(list) &&
  list.length > 0 &&
  new Set(list).size === list.length &&
  list.every((k) => Object.hasOwn(valid, k));

export function validateRecipe(r) {
  insist(r && modes.includes(r.task), 'Choose a classification or regression task.');
  insist(
    between(r.seconds, 0.25, 30) && between(r.overlap, 0, 90),
    'Choose a window of 0.25–30 seconds and overlap of 0–90%.'
  );
  insist(uniqueKeys(r.channels, channels), 'Select at least one sensor channel.');
  insist(uniqueKeys(r.features, features), 'Connect at least one feature.');
  insist(['standard', 'minmax', 'none'].includes(r.scale), 'Choose a normalization method.');
  insist(r.filters && typeof r.filters === 'object', 'Invalid filter configuration.');
  for (const [key, f] of Object.entries(r.filters)) {
    insist(
      Object.hasOwn(channels, key) && f && ['none', 'low', 'high', 'band'].includes(f.type),
      'Unknown channel filter.'
    );
    if (['high', 'band'].includes(f.type))
      insist(Number.isFinite(f.low) && f.low > 0, 'Enter a positive high-pass cutoff.');
    if (['low', 'band'].includes(f.type))
      insist(Number.isFinite(f.high) && f.high > 0, 'Enter a positive low-pass cutoff.');
    if (f.type === 'band') insist(f.low < f.high, 'The lower band edge must be below the upper edge.');
  }
}
export function rangesFor(bounds, record, r) {
  const [a, b] = bounds;
  if (r.split === 'recording') {
    insist(partitions.includes(record.partition), 'Assign each file to a partition.');
    return [[record.partition, a, b]];
  }
  insist(
    r.split === 'time' && r.trainPct > 0 && r.validPct > 0 && r.trainPct + r.validPct < 100,
    'Leave a positive percentage for each of the three partitions.'
  );
  const trainEnd = a + ((b - a) * r.trainPct) / 100,
    validEnd = a + ((b - a) * (r.trainPct + r.validPct)) / 100;
  return [
    ['train', a, trainEnd],
    ['validation', trainEnd, validEnd],
    ['test', validEnd, b]
  ];
}
export function extractWindows(records, recipe, sets = partitions) {
  validateRecipe(recipe);
  insist(records.length > 0, 'Import your recordings first.');
  const rows = { train: [], validation: [], test: [] },
    audit = [];
  const width = recipe.seconds * 1000,
    hop = width * (1 - recipe.overlap / 100);
  let candidates = 0;
  records.forEach((r, i) => {
    const absent = recipe.channels.filter((k) => !r.source.available.includes(k));
    insist(
      !absent.length,
      `${r.name} is missing ${absent.map((k) => channels[k][0]).join(', ')}. Select channels present in every recording.`
    );
    const counts = {
      name: r.name,
      label: r.label,
      train: 0,
      validation: 0,
      test: 0,
      skipped: 0,
      trainSkipped: 0
    };
    for (const [partition, a, b] of rangesFor(r.source.bounds, r, recipe)) {
      if (!sets.includes(partition)) continue;
      const count = Math.max(0, Math.floor((b - a - width + 0.0001) / hop) + 1);
      candidates += count;
      insist(
        candidates <= 20000,
        'This configuration exceeds 20,000 windows. Increase window duration or reduce overlap.'
      );
      for (let n = 0; n < count; n++) {
        const x = featureRow(r.source, a + n * hop, recipe);
        if (!x) {
          counts.skipped++;
          if (partition === 'train') counts.trainSkipped++;
          continue;
        }
        rows[partition].push({ x, record: i, seconds: (a + n * hop - r.source.bounds[0]) / 1000 });
        counts[partition]++;
      }
    }
    audit.push(counts);
  });
  return { rows, audit };
}
export function prepare(records, recipe) {
  insist(
    records.every((r) => typeof r.label === 'string' && r.label.trim()),
    'Enter a class or target for every recording.'
  );
  const categorical = recipe.task === 'classification';
  const labels = categorical ? [...new Set(records.map((r) => r.label.trim()))].sort() : [];
  const targets = records.map((r) => (categorical ? labels.indexOf(r.label.trim()) : Number(r.label)));
  insist(targets.every(Number.isFinite), 'Regression requires a finite number for every target.');
  insist(new Set(targets).size >= 2, 'Use at least two different behavior labels or target values.');
  const { rows, audit } = extractWindows(records, recipe);
  for (const set of partitions) for (const row of rows[set]) row.y = targets[row.record];
  for (const set of partitions)
    insist(
      rows[set].length,
      `No complete ${set} windows. Check file assignments, window length, gaps, and sample rates. Spectral features need four samples per channel.`
    );
  const seen = new Set(rows.train.map((r) => r.y));
  insist(
    seen.size >= 2 && (!categorical || seen.size === labels.length),
    'Training needs windows for each class, or two distinct regression targets. Check assignments and missing data.'
  );
  const trainingRows = rows.train.map(({ x, record, seconds }) => ({ x, record, seconds }));
  const scale = fitScale(
    rows.train.map((r) => r.x),
    recipe.scale
  );
  for (const set of partitions) for (const row of rows[set]) row.x = transform(row.x, scale);
  return { rows, scale, labels, audit, trainingRows };
}
export function trainRun(records, recipe, choices, progress = () => {}) {
  insist(choices.length, 'Connect a model block to the pipeline.');
  progress('Preparing windows and features…');
  const { rows, scale, labels, audit, trainingRows } = prepare(records, recipe);
  const candidates = choices.map(({ kind, param }) => {
    progress('Training ' + models[kind].name + '…');
    const model = fitModel(
      kind,
      param,
      rows.train.map((r) => r.x),
      rows.train.map((r) => r.y),
      labels.length
    );
    const artifact = { format: 'pal-behavior-model', version: 1, recipe, scale, labels, param, model };
    return { kind, artifact, validation: evaluate(model, rows.validation) };
  });
  const score = (c) => (labels.length ? c.validation.f1 : -c.validation.rmse);
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a)).kind;
  return { candidates, best, audit, test: rows.test, validation: rows.validation, trainingRows, scale };
}
export function validateArtifact(a) {
  const fail = 'This file is not a valid PAL behavior model.';
  insist(a?.format === 'pal-behavior-model' && a.version === 1, fail);
  validateRecipe(a.recipe);
  const width =
    a.recipe.channels.length * a.recipe.features.reduce((n, f) => n + (f === 'raw' ? 32 : 1), 0);
  const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  insist(
    vector(a.scale?.center, width) &&
      vector(a.scale?.spread, width) &&
      a.scale.spread.every((v) => v > 0),
    fail
  );
  insist(
    Array.isArray(a.labels) &&
      a.labels.every((s) => typeof s === 'string' && s.trim()) &&
      new Set(a.labels).size === a.labels.length,
    fail
  );
  const m = a.model,
    c = a.labels.length;
  insist(
    (a.recipe.task === 'classification' ? c >= 2 : c === 0) &&
      m?.classes === c &&
      Object.hasOwn(models, m.kind),
    fail
  );
  const spec = models[m.kind];
  insist(between(a.param, spec.min, spec.max) && (spec.step !== 1 || Number.isInteger(a.param)), fail);
  if (m.kind === 'knn' || m.kind === 'kernel') {
    insist(
      Array.isArray(m.x) &&
        m.x.length > 0 &&
        m.x.every((r) => vector(r, width)) &&
        vector(m.y, m.x.length) &&
        m.param === a.param &&
        (m.kind !== 'knn' || m.param <= m.x.length),
      fail
    );
    insist(!c || m.y.every((y) => Number.isInteger(y) && between(y, 0, c - 1)), fail);
  } else if (m.kind === 'ridge') {
    insist(
      Array.isArray(m.weights) &&
        m.weights.length === width + 1 &&
        m.weights.every((row) => vector(row, c || 1)),
      fail
    );
  } else {
    const treeOK = (node, depth) =>
      node &&
      depth <= 12 &&
      (node.value
        ? vector(node.value, c || 1)
        : Number.isInteger(node.column) &&
          between(node.column, 0, width - 1) &&
          Number.isFinite(node.threshold) &&
          treeOK(node.low, depth + 1) &&
          treeOK(node.high, depth + 1));
    insist(
      Array.isArray(m.trees) &&
        m.trees.length === (m.kind === 'forest' ? a.param : 1) &&
        m.trees.every((t) => treeOK(t, 0)),
      fail
    );
  }
  return a;
}
export function inferWindow(source, start, a) {
  const x = featureRow(source, start, a.recipe);
  if (!x) return null;
  const result = predict(a.model, transform(x, a.scale));
  return a.labels.length ? a.labels[result.value] : result.value;
}
