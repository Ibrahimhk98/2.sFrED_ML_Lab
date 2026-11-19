import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyGraph,
  starterGraph,
  createBlock,
  connect,
  removeBlock,
  branch,
  trainingGroups,
  incomingModels
} from '../dashboard/lab/graph.js';

function add(graph, type) {
  const node = createBlock(type, 0, 0);
  graph.nodes.push(node);
  return node.id;
}
test('only explicitly wired branches contribute to execution, including bypasses', () => {
  const g = starterGraph();
  const node = (type) => g.nodes.find((n) => n.type === type);
  node('filters').settings.filters = { ax: { type: 'low', high: 12 } };
  const knn = node('knn').id,
    extra = add(g, 'knn');
  let groups = trainingGroups(g, [], 'classification');
  assert.deepEqual(groups[0].choices, [{ id: knn, kind: 'knn', param: 5 }]);
  assert.equal(groups[0].recipe.scale, 'standard');
  assert.equal(groups[0].recipe.filters.ax.high, 12);
  connect(g, node('features').id, extra);
  g.nodes.find((n) => n.id === extra).settings.param = 9;
  groups = trainingGroups(g, [], 'classification');
  assert.equal(groups.length, 2);
  assert.equal(groups[1].recipe.scale, 'none');
  assert.deepEqual(groups[1].choices, [{ id: extra, kind: 'knn', param: 9 }]);
  connect(g, node('windows').id, node('features').id);
  assert.deepEqual(branch(g, knn, [], 'classification').recipe.filters, {});
  removeBlock(g, node('windows').id);
  assert.deepEqual(trainingGroups(g, [], 'classification'), []);
});
test('wires reject incompatible and duplicate connections and support fan-out and comparison fan-in', () => {
  const g = emptyGraph();
  const source = add(g, 'source'),
    windows = add(g, 'windows'),
    features = add(g, 'features'),
    tree = add(g, 'tree'),
    ridge = add(g, 'ridge'),
    scores = add(g, 'scores'),
    live = add(g, 'live');
  for (const [a, b] of [
    [source, windows],
    [windows, features],
    [features, tree],
    [features, ridge],
    [tree, scores],
    [ridge, scores],
    [scores, live]
  ])
    assert.equal(connect(g, a, b), true);
  assert.equal(connect(g, tree, scores), false);
  const before = structuredClone(g.edges);
  assert.throws(() => connect(g, source, tree), /different data/);
  assert.throws(() => connect(g, features, windows), /different data/);
  assert.deepEqual(g.edges, before);
  assert.deepEqual(
    incomingModels(g, live).map((n) => n.id),
    [tree, ridge]
  );
  connect(g, tree, live);
  assert.deepEqual(
    incomingModels(g, live).map((n) => n.id),
    [tree]
  );
  removeBlock(g, tree);
  assert.deepEqual(
    incomingModels(g, scores).map((n) => n.id),
    [ridge]
  );
  assert.ok(g.edges.every((e) => e.to !== tree && e.from !== tree));
});
test('multiple preparation instances keep independent window settings and partition assignments', () => {
  const g = starterGraph(),
    source = g.nodes.find((n) => n.type === 'source'),
    original = g.nodes.find((n) => n.type === 'windows');
  const second = add(g, 'windows'),
    features = add(g, 'features');
  connect(g, source.id, second);
  connect(g, second, features);
  const records = [{ id: 'a', partition: 'train', label: '1' }];
  Object.assign(g.nodes.find((n) => n.id === second).settings, {
    seconds: 7,
    split: 'recording',
    partitions: { a: 'test' }
  });
  const data = branch(g, features, records, 'regression');
  assert.equal(data.recipe.seconds, 7);
  assert.equal(data.records[0].partition, 'test');
  assert.equal(data.recipe.task, 'regression');
  assert.equal(branch(g, original.id, records, 'regression').recipe.seconds, 2);
  assert.equal(records[0].partition, 'train');
});
