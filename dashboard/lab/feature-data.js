import { channels, features } from './catalog.js';
import { extractWindows } from './pipeline.js';
import { fitScale } from './models.js';

export function featureColumns(recipe) {
  return recipe.channels.flatMap((key) =>
    recipe.features.flatMap((feature) => {
      const [channel, unit] = channels[key];
      if (feature === 'raw')
        return Array.from({ length: 32 }, (_, i) => ({ name: `${channel} · sample ${i + 1}/32`, unit }));
      return [
        {
          name: channel + ' · ' + features[feature],
          unit: ['peakHz', 'centroid'].includes(feature) ? 'Hz' : unit
        }
      ];
    })
  );
}
export function extractPreview(records, recipe) {
  const {
    rows: { train },
    audit
  } = extractWindows(records, recipe, ['train']);
  if (!train.length)
    throw new Error(
      'No complete training windows. Check file assignments, window length, and channel coverage.'
    );
  return describePreview(
    records,
    recipe,
    train,
    audit,
    fitScale(
      train.map((r) => r.x),
      recipe.scale
    )
  );
}
export function describePreview(records, recipe, rows, audit, scale) {
  return {
    rows,
    scale,
    columns: featureColumns(recipe),
    audit,
    files: records.map((r) => ({ name: r.name, label: r.label.trim() })),
    task: recipe.task
  };
}
export function plotColumns(preview, { x, y, scaled, record }) {
  const { rows, columns, scale, files } = preview;
  if (!columns[x] || (y !== -1 && !columns[y])) throw new Error('Choose an extracted feature.');
  const value = (row, i) => (scaled ? (row.x[i] - scale.center[i]) / scale.spread[i] : row.x[i]);
  return rows
    .filter((r) => record === -1 || r.record === record)
    .map((r) => ({
      x: value(r, x),
      y: y === -1 ? (files[r.record].label !== '' ? Number(files[r.record].label) : null) : value(r, y),
      record: r.record,
      seconds: r.seconds
    }));
}
