import { defaults, models, stages } from './catalog.js';

export const groups = {
  Dataset: ['source', 'scope'],
  Processing: ['windows', 'filters', 'features', 'scale', 'plots'],
  Models: Object.keys(models),
  Results: ['scores', 'live']
};
export const title = (type) => stages[type]?.[0] ?? models[type].name;
const tableInputs = ['features', 'scaled'];
export const ports = {
  source: { input: [], output: 'recordings' },
  scope: { input: ['recordings'] },
  windows: { input: ['recordings'], output: 'windows' },
  filters: { input: ['windows'], output: 'filtered' },
  features: { input: ['windows', 'filtered'], output: 'features' },
  scale: { input: ['features'], output: 'scaled' },
  plots: { input: tableInputs },
  ...Object.fromEntries(Object.keys(models).map((k) => [k, { input: tableInputs, output: 'model' }])),
  scores: { input: ['model'], many: true, output: 'ranking' },
  live: { input: ['model', 'ranking'] }
};
export const portNames = {
  recordings: 'Recordings',
  windows: 'Windows',
  filtered: 'Filtered',
  features: 'Features',
  scaled: 'Scaled',
  model: 'Model',
  ranking: 'Ranked models'
};
export const tones = {
  source: 'connect',
  scope: 'accel',
  windows: 'ble',
  filters: 'env',
  features: 'wifi',
  scale: 'env',
  plots: 'accel',
  scores: 'gyro',
  live: 'audio'
};
export const toneOf = (type) => tones[type] || 'iaq';
const keys = {
  windows: ['split', 'trainPct', 'validPct', 'seconds', 'overlap'],
  filters: ['filters'],
  features: ['channels', 'features'],
  scale: ['scale']
};
export function createBlock(type, x, y) {
  if (!Object.hasOwn(ports, type)) throw new Error('Unknown block type.');
  const d = defaults();
  const settings = Object.fromEntries((keys[type] || []).map((k) => [k, d[k]]));
  if (type === 'windows') settings.partitions = {};
  if (models[type]) settings.param = models[type].value;
  return { id: crypto.randomUUID(), type, x, y, settings };
}
export function emptyGraph() {
  return { nodes: [], edges: [] };
}
export const findNode = (g, id) => g.nodes.find((n) => n.id === id);
export const inputsOf = (g, id) => g.edges.filter((e) => e.to === id).map((e) => findNode(g, e.from));
export function connect(g, from, to) {
  const src = findNode(g, from),
    dst = findNode(g, to);
  if (!src || !dst || from === to || !ports[dst.type].input.includes(ports[src.type].output))
    throw new Error('These ports carry different data. Choose a highlighted port.');
  if (g.edges.some((e) => e.from === from && e.to === to)) return false;
  // Port types progress strictly from recordings to results, so a compatible edge cannot form a cycle.
  if (!ports[dst.type].many) g.edges = g.edges.filter((e) => e.to !== to);
  g.edges.push({ from, to });
  return true;
}
export function removeBlock(g, id) {
  g.nodes = g.nodes.filter((n) => n.id !== id);
  g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
}
export function starterGraph() {
  const g = emptyGraph(),
    column = (i) => 32 + 224 * i;
  for (const [type, col, y] of [
    ['source', 0, 168],
    ['windows', 1, 168],
    ['filters', 2, 168],
    ['features', 3, 168],
    ['scale', 4, 168],
    ['scope', 1, 24],
    ['plots', 4, 24],
    ['knn', 1, 328],
    ['scores', 2, 328],
    ['live', 3, 328]
  ])
    g.nodes.push(createBlock(type, column(col), y));
  const id = (k) => g.nodes.find((n) => n.type === k).id;
  for (const [a, b] of [
    ['source', 'scope'],
    ['source', 'windows'],
    ['windows', 'filters'],
    ['filters', 'features'],
    ['features', 'scale'],
    ['scale', 'plots'],
    ['scale', 'knn'],
    ['knn', 'scores'],
    ['scores', 'live']
  ])
    connect(g, id(a), id(b));
  return g;
}
// Read only the upstream wires of this block. Each processing instance owns its settings.
export function branch(g, id, records, task) {
  const recipe = { ...defaults(), task, scale: 'none', filters: {} };
  let n = findNode(g, id),
    partitions = {},
    table = null;
  while (n) {
    for (const key of keys[n.type] || []) recipe[key] = n.settings[key];
    if (!table && ['features', 'scale'].includes(n.type)) table = n.id;
    if (n.type === 'windows') partitions = n.settings.partitions;
    if (n.type === 'source') {
      recipe.filters = Object.fromEntries(
        Object.entries(recipe.filters).filter(([k]) => recipe.channels.includes(k))
      );
      return {
        recipe,
        table,
        records: records.map((r) => ({ ...r, partition: partitions[r.id] || r.partition }))
      };
    }
    const parent = inputsOf(g, n.id)[0];
    if (!parent) return { missing: n };
    n = parent;
  }
  return {};
}
export function trainingGroups(g, records, task) {
  const groups = new Map();
  for (const n of g.nodes.filter((n) => models[n.type])) {
    const data = branch(g, n.id, records, task);
    if (data.missing) continue;
    if (!groups.has(data.table)) groups.set(data.table, { ...data, choices: [] });
    groups.get(data.table).choices.push({ id: n.id, kind: n.type, param: n.settings.param });
  }
  return [...groups.values()];
}
export function incomingModels(g, id) {
  return inputsOf(g, id)
    .flatMap((n) => (n.type === 'scores' ? inputsOf(g, n.id) : [n]))
    .filter((n) => models[n.type]);
}
export function blockName(g, node) {
  const peers = g.nodes.filter((n) => n.type === node.type);
  return title(node.type) + (peers.length > 1 ? ' ' + (peers.indexOf(node) + 1) : '');
}
