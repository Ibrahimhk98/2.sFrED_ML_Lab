import { Matrix, solve } from '../vendor/lab-math.js';
import { models } from './catalog.js';

export function fitScale(x, mode) {
  const center = [],
    spread = [];
  for (let j = 0; j < x[0].length; j++) {
    let lo = Infinity,
      hi = -Infinity,
      mean = 0,
      variance = 0;
    x.forEach((row, i) => {
      const v = row[j],
        delta = v - mean;
      mean += delta / (i + 1);
      variance += delta * (v - mean);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    });
    center.push(mode === 'standard' ? mean : mode === 'minmax' ? lo : 0);
    spread.push(
      (mode === 'standard' ? Math.sqrt(variance / x.length) : mode === 'minmax' ? hi - lo : 1) || 1
    );
  }
  return { center, spread };
}
export const transform = (row, scale) => row.map((v, j) => (v - scale.center[j]) / scale.spread[j]);

function seededRandom() {
  let state = 2026;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function growTree(x, y, rows, classes, depth, random) {
  const total = new Array(classes || 1).fill(0);
  for (const i of rows) total[classes ? y[i] : 0] += classes ? 1 : y[i];
  const leaf = () => ({ value: total.map((v) => v / rows.length) });
  if (!depth || rows.length < 4 || rows.every((i) => y[i] === y[rows[0]])) return leaf();
  const columns = x[0].map((_, j) => j);
  if (random) {
    for (let j = columns.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [columns[k], columns[j]] = [columns[j], columns[k]];
    }
    columns.length = Math.ceil(Math.sqrt(columns.length));
  }
  // Maximizing squared child sums / child size minimizes Gini impurity
  // (class counts) or within-leaf squared error (continuous target sums).
  const squareSum = (a) => a.reduce((s, v) => s + v * v, 0);
  let bestScore = squareSum(total) / rows.length,
    column,
    threshold;
  for (const j of columns) {
    const order = rows.slice().sort((a, b) => x[a][j] - x[b][j]);
    const left = new Array(total.length).fill(0),
      right = total.slice();
    let leftSq = 0,
      rightSq = squareSum(right);
    for (let n = 1; n < order.length; n++) {
      const i = order[n - 1],
        k = classes ? y[i] : 0,
        v = classes ? 1 : y[i];
      leftSq += 2 * left[k] * v + v * v;
      rightSq += v * v - 2 * right[k] * v;
      left[k] += v;
      right[k] -= v;
      if (n < 2 || order.length - n < 2 || x[i][j] === x[order[n]][j]) continue;
      const score = leftSq / n + rightSq / (order.length - n);
      if (score > bestScore) {
        bestScore = score;
        column = j;
        threshold = x[i][j] / 2 + x[order[n]][j] / 2;
      }
    }
  }
  if (column === undefined) return leaf();
  const low = [],
    high = [];
  for (const i of rows) (x[i][column] < threshold ? low : high).push(i);
  return {
    column,
    threshold,
    low: growTree(x, y, low, classes, depth - 1, random),
    high: growTree(x, y, high, classes, depth - 1, random)
  };
}
export function fitModel(kind, param, x, y, classes) {
  const spec = models[kind];
  if (
    !spec ||
    !Number.isFinite(param) ||
    param < spec.min ||
    param > spec.max ||
    (spec.step === 1 && !Number.isInteger(param))
  )
    throw new Error('Choose a valid model parameter.');
  if (kind === 'knn' && param > x.length)
    throw new Error('Neighbors must fit within the number of training windows.');
  if (kind === 'knn' || kind === 'kernel') return { kind, param, x, y, classes };
  if (kind === 'ridge') {
    const design = new Matrix(x.map((row) => [...row, 1])),
      transpose = design.transpose();
    const gram = transpose.mmul(design);
    for (let j = 0; j < x[0].length; j++) gram.set(j, j, gram.get(j, j) + param);
    const targets = new Matrix(
      y.map((v) => (classes ? Array.from({ length: classes }, (_, j) => Number(v === j)) : [v]))
    );
    return { kind, classes, weights: solve(gram, transpose.mmul(targets)).to2DArray() };
  }
  const rows = y.map((_, i) => i);
  if (kind === 'tree') return { kind, classes, trees: [growTree(x, y, rows, classes, param, null)] };
  const random = seededRandom();
  const trees = Array.from({ length: param }, () =>
    growTree(
      x,
      y,
      rows.map(() => Math.floor(random() * rows.length)),
      classes,
      8,
      random
    )
  );
  return { kind, classes, trees };
}
export function predict(model, row) {
  const scores = new Array(model.classes || 1).fill(0);
  if (model.kind === 'ridge') {
    for (let k = 0; k < scores.length; k++) {
      scores[k] = model.weights.at(-1)[k];
      for (let j = 0; j < row.length; j++) scores[k] += row[j] * model.weights[j][k];
    }
  } else if (model.kind === 'tree' || model.kind === 'forest') {
    for (let tree of model.trees) {
      while (!tree.value) tree = row[tree.column] < tree.threshold ? tree.low : tree.high;
      tree.value.forEach((v, k) => (scores[k] += v / model.trees.length));
    }
  } else {
    const distances = model.x.map((other, i) => ({
      i,
      d: other.reduce((s, v, j) => s + (v - row[j]) ** 2, 0)
    }));
    let nearest = Infinity;
    for (const p of distances) nearest = Math.min(nearest, p.d);
    if (model.kind === 'knn') {
      distances.sort((a, b) => a.d - b.d);
      distances.length = model.param;
    }
    let total = 0;
    for (const { i, d } of distances) {
      const w = model.kind === 'knn' ? 1 : Math.exp(-(d - nearest) / (2 * model.param ** 2));
      const y = model.y[i];
      total += w;
      scores[model.classes ? y : 0] += model.classes ? w : w * y;
    }
    for (let k = 0; k < scores.length; k++) scores[k] /= total;
  }
  if (!scores.every(Number.isFinite))
    throw new Error('Non-finite model output. Check features and try standard normalization.');
  return { value: model.classes ? scores.indexOf(Math.max(...scores)) : scores[0], scores };
}
function binaryAuc(truth, predictions, label) {
  const order = truth
    .map((y, i) => ({ positive: y === label, score: predictions[i].scores[label] }))
    .sort((a, b) => a.score - b.score);
  let positives = 0,
    rankSum = 0;
  for (let i = 0; i < order.length;) {
    let j = i + 1;
    while (j < order.length && order[i].score === order[j].score) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++)
      if (order[k].positive) {
        positives++;
        rankSum += rank;
      }
    i = j;
  }
  if (!positives || positives === truth.length) return null;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * (truth.length - positives));
}
export function evaluate(model, rows) {
  const results = rows.map((r) => predict(model, r.x)),
    truth = rows.map((r) => r.y),
    n = rows.length;
  if (!model.classes) {
    const mean = truth.reduce((s, v) => s + v, 0) / n;
    let squared = 0,
      absolute = 0,
      variance = 0;
    truth.forEach((y, i) => {
      const e = y - results[i].value;
      squared += e * e;
      absolute += Math.abs(e);
      variance += (y - mean) ** 2;
    });
    return {
      mae: absolute / n,
      rmse: Math.sqrt(squared / n),
      r2: variance ? 1 - squared / variance : null
    };
  }
  const c = model.classes,
    matrix = Array.from({ length: c }, () => new Array(c).fill(0));
  truth.forEach((y, i) => matrix[y][results[i].value]++);
  let precision = 0,
    recall = 0,
    f1 = 0,
    correct = 0;
  for (let k = 0; k < c; k++) {
    const tp = matrix[k][k],
      actual = matrix[k].reduce((a, b) => a + b, 0),
      predicted = matrix.reduce((s, r) => s + r[k], 0);
    correct += tp;
    precision += tp / (predicted || 1);
    recall += tp / (actual || 1);
    f1 += (2 * tp) / (actual + predicted || 1);
  }
  const aucs = matrix.map((_, k) => binaryAuc(truth, results, k));
  return {
    accuracy: correct / n,
    precision: precision / c,
    recall: recall / c,
    f1: f1 / c,
    auc: aucs.includes(null) ? null : aucs.reduce((s, v) => s + v, 0) / c,
    matrix
  };
}
