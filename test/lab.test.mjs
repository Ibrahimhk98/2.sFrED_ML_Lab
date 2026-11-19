import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, models } from '../dashboard/lab/catalog.js';
import { exampleTrial } from '../dashboard/lab/examples.js';
import {
  indexSession,
  uniformWindow,
  spectrum,
  filterSignal,
  featureRow
} from '../dashboard/lab/signals.js';
import {
  trainRun,
  prepare,
  validateArtifact,
  inferWindow,
  extractWindows
} from '../dashboard/lab/pipeline.js';
import { featureColumns, extractPreview, plotColumns } from '../dashboard/lab/feature-data.js';
import { evaluate, predict, transform } from '../dashboard/lab/models.js';
import { LiveWindow } from '../dashboard/lab/live.js';

const records = Array.from({ length: 6 }, (_, i) => {
  const { session, ...info } = exampleTrial(i);
  return { ...info, source: indexSession(session) };
});
const choices = Object.entries(models).map(([kind, m]) => ({ kind, param: m.value }));

test('every sample in overlapping windows stays inside a single time or recording partition', () => {
  const recipe = { ...defaults(), overlap: 75 },
    trial = records[0];
  const { rows } = extractWindows([trial], recipe);
  assert.equal(rows.train[1].seconds - rows.train[0].seconds, 0.5);
  assert.ok(rows.train.at(-1).seconds + recipe.seconds <= rows.validation[0].seconds);
  assert.ok(rows.validation.at(-1).seconds + recipe.seconds <= rows.test[0].seconds);
  const held = prepare(records, { ...recipe, split: 'recording' });
  assert.deepEqual([...new Set(held.rows.train.map((r) => r.record))], [0, 1]);
  assert.deepEqual([...new Set(held.rows.validation.map((r) => r.record))], [2, 3]);
  assert.deepEqual([...new Set(held.rows.test.map((r) => r.record))], [4, 5]);
});

test('extracted feature columns, raw positions, plots and model inputs agree before and after normalization', () => {
  const recipe = {
    ...defaults(),
    channels: ['audio', 'ax', 'temperature_c'],
    features: ['raw', 'peakHz', 'rms'],
    seconds: 4,
    split: 'recording'
  };
  const preview = extractPreview(records, recipe),
    dataset = prepare(records, recipe);
  assert.equal(featureColumns(recipe).length, 3 * 34);
  assert.match(preview.columns[31].name, /Microphone · sample 32/);
  assert.equal(preview.columns[32].unit, 'Hz');
  assert.deepEqual(preview.scale, dataset.scale);
  const points = plotColumns(preview, { x: 32, y: 67, scaled: true, record: -1 });
  assert.deepEqual(
    points.map((p) => [p.x, p.y]),
    dataset.rows.train.map((r) => [r.x[32], r.x[67]])
  );
  assert.deepEqual([...new Set(points.map((p) => p.record))], [0, 1]);
  assert.equal(
    plotColumns(preview, { x: 0, y: 32, scaled: false, record: 0 })[0].x,
    preview.rows[0].x[0]
  );
  const regression = extractPreview(
    records.map((r, i) => ({ ...r, label: String(i + 20) })),
    { ...recipe, task: 'regression' }
  );
  assert.ok(plotColumns(regression, { x: 0, y: -1, scaled: false, record: 1 }).every((p) => p.y === 21));
  // An extreme held-out signal must never shift the fitted transformation.
  const changed = records.map((r, i) =>
    i < 2
      ? r
      : {
          ...r,
          source: indexSession({
            ...r.source.session,
            imu: r.source.session.imu.map((p) => ({ ...p, ax: p.ax + 1e4 }))
          })
        }
  );
  assert.deepEqual(
    prepare(changed, { ...defaults(), split: 'recording' }).scale,
    prepare(records, { ...defaults(), split: 'recording' }).scale
  );
});

test('FFT resolves a known tone and input filters attenuate the appropriate frequencies', () => {
  const rate = 1024,
    samples = Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * 128 * i) / rate));
  const { amplitudes, binHz } = spectrum(samples, rate);
  assert.equal(amplitudes.indexOf(Math.max(...amplitudes)) * binHz, 128);
  assert.ok(Math.abs(amplitudes[128] - 1) < 0.005);
  const rms = (v) => Math.sqrt(v.slice(150).reduce((n, x) => n + x * x, 0) / (v.length - 150));
  assert.ok(rms(filterSignal(samples, rate, { type: 'low', high: 16 })) < 0.03);
  assert.ok(rms(filterSignal(samples, rate, { type: 'high', low: 16 })) > 0.65);
  assert.ok(rms(filterSignal(samples, rate, { type: 'band', low: 80, high: 200 })) > 0.5);
  assert.throws(() => filterSignal(samples, rate, { type: 'low', high: 512 }), /cutoff/);
  const session = records[0].source.session;
  const source = indexSession({ ...session, audio: session.audio.filter((_, i) => i !== 10) });
  assert.equal(uniformWindow(source, 'audio', source.bounds[0], source.bounds[0] + 2000), null);
  assert.equal(featureRow(source, source.bounds[0], { ...defaults(), channels: ['audio'] }), null);
  assert.ok(uniformWindow(source, 'ax', source.bounds[0], source.bounds[0] + 2000));
});

for (const task of ['classification', 'regression'])
  test('all five ' + task + ' models survive JSON export and live feature extraction', () => {
    const trials = records.map((r, i) => ({ ...r, label: String(i % 2 ? 120 : 0) }));
    const recipe = {
      ...defaults(),
      task,
      split: 'recording',
      channels: ['ax', 'temperature_c'],
      filters: { ax: { type: 'low', high: 30 } },
      features: ['mean', 'rms', 'range']
    };
    const run = trainRun(trials, recipe, choices),
      held = prepare(trials, recipe);
    const source = trials[4].source,
      start = source.bounds[0];
    for (const candidate of run.candidates) {
      const model = validateArtifact(JSON.parse(JSON.stringify(candidate.artifact)));
      const score = evaluate(model.model, run.test);
      assert.ok(task === 'classification' ? score.f1 >= 0.75 : score.mae < 60);
      const value = predict(model.model, held.rows.test[0].x).value;
      assert.equal(inferWindow(source, start, model), model.labels.length ? model.labels[value] : value);
      assert.deepEqual(
        transform(featureRow(source, start, model.recipe), model.scale),
        held.rows.test[0].x
      );
      const invalid = structuredClone(model);
      invalid.scale.spread[0] = 0;
      assert.throws(() => validateArtifact(invalid), /valid PAL/);
    }
  });

test('macro ROC AUC gives half credit for ties and is undefined for an absent test class', () => {
  const model = {
    kind: 'ridge',
    classes: 2,
    weights: [
      [0, 0],
      [1, 1]
    ]
  };
  const rows = [0, 1, 0, 1].map((y) => ({ x: [0], y }));
  const score = evaluate(model, rows);
  assert.equal(score.auc, 0.5);
  assert.equal(score.accuracy, 0.5);
  assert.deepEqual(score.matrix, [
    [2, 0],
    [2, 0]
  ]);
  assert.equal(evaluate(model, [rows[0]]).auc, null);
});
test('live buffer waits for all required sensors and clears history on a kit change', () => {
  const source = records[0].source,
    live = new LiveWindow({ ...defaults(), channels: ['audio', 'ax'] });
  const add = (group, rows, id = 'a') => live.append({ group, rows, connection: { epoch: 'usb', id } });
  assert.equal(add('imu', source.session.imu.slice(0, 220)), null);
  const window = add('audio', source.session.audio.slice(0, 21));
  assert.ok(window);
  assert.ok(featureRow(indexSession(window.session), window.start, live.recipe));
  assert.equal(add('audio', source.session.audio.slice(21, 22), 'b'), null);
  assert.equal(live.session.imu.length, 0);
});
