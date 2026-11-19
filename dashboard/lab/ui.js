import { channels, groups, features, models, stages } from './catalog.js';
import {
  starterGraph,
  ports,
  portNames,
  toneOf,
  findNode,
  inputsOf,
  branch,
  trainingGroups,
  incomingModels,
  blockName
} from './graph.js';
import { graphEditor } from './editor.js';
import { mountPlots, plotDefaults } from './feature-plots.js';
import { mountScope, scopeDefaults } from './scope.js';
import { deployment } from './deploy.js';

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const checked = (on) => (on ? 'checked' : '');
const options = (entries, value) =>
  entries
    .map(
      ([key, name]) =>
        `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(name)}</option>`
    )
    .join('');
const partitionOptions = [
  ['train', 'Train'],
  ['validation', 'Validation'],
  ['test', 'Test']
];
const graph = starterGraph(),
  records = [],
  dataset = { task: 'classification' };
let selected = graph.nodes[0],
  config = dataset,
  busy = false,
  nextId = 0;
let candidates = new Map(),
  previews = new Map(),
  testScores = {},
  revealed = new Set();
let signature = '',
  wiring = '',
  liveNode = null,
  editor;
const jobs = new Map(),
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const send = (action, payload) => worker.postMessage({ action, payload });
const call = (action, payload) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, action, payload });
  });
function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = error;
}
worker.onmessage = ({ data }) => {
  if (data.progress) {
    status(data.progress);
    return;
  }
  if (Object.hasOwn(data, 'prediction')) {
    deploy.update(data.prediction);
    return;
  }
  const job = jobs.get(data.id);
  if (job) {
    jobs.delete(data.id);
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.value);
  } else if (data.error) {
    deploy.stop();
    status(data.error, true);
  }
};
worker.onerror = () => {
  const message =
    'The analytics worker could not start. Run npm ci and open the dashboard on localhost.';
  for (const job of jobs.values()) job.reject(new Error(message));
  jobs.clear();
  status(message, true);
};
const deploy = deployment(call, send, esc, status);
function invalidate() {
  if (candidates.size || previews.size) send('invalidate');
  candidates.clear();
  previews.clear();
  testScores = {};
  revealed.clear();
  deploy.stop();
  queueMicrotask(() => {
    editor?.render();
    toolbar();
  });
}
function computationWires() {
  return JSON.stringify(
    graph.edges.filter((e) => !['plots', 'scope', 'scores', 'live'].includes(findNode(graph, e.to).type))
  );
}
function topologyChanged() {
  if (records.length) {
    const common = records[0].channels.filter((k) => records.every((r) => r.channels.includes(k)));
    const availableKeys = available();
    for (const n of graph.nodes.filter((n) => n.type === 'features')) {
      if (n.settings.channels.length && !n.settings.channels.some((k) => availableKeys.includes(k)))
        n.settings.channels = [common[0] || availableKeys[0]];
    }
  }
  const next = computationWires(),
    nextWiring = JSON.stringify(graph.edges);
  if (signature !== next) invalidate();
  else if (wiring !== nextWiring) deploy.stop();
  signature = next;
  wiring = nextWiring;
}
function describe(n) {
  const s = n.settings;
  if (models[n.type]) return models[n.type].param + ' · ' + s.param;
  switch (n.type) {
    case 'source':
      return records.length ? records.length + ' recordings' : 'HDF5 recordings';
    case 'scope':
      return 'Time series / FFT';
    case 'windows':
      return s.seconds + ' s · ' + s.overlap + '% overlap';
    case 'filters': {
      const count = Object.values(s.filters).filter((f) => f.type !== 'none').length;
      return count ? count + ' active filters' : 'Pass through';
    }
    case 'features':
      return (
        s.channels.length +
        (s.channels.length === 1 ? ' channel' : ' channels') +
        ' · ' +
        s.features.length +
        (s.features.length === 1 ? ' feature' : ' features')
      );
    case 'scale':
      return { standard: 'Standard score', minmax: 'Min–max', none: 'Pass through' }[s.scale];
    case 'plots':
      return 'Distributions & trends';
    case 'scores': {
      const count = incomingModels(graph, n.id).length;
      return count + ' model input' + (count === 1 ? '' : 's');
    }
    case 'live':
      return 'Export / live inference';
  }
}
function toolbar() {
  $('datasetStatus').textContent = records.length + ' recording' + (records.length === 1 ? '' : 's');
  $('datasetDot').classList.toggle('connected', !!records.length);
  const groups = trainingGroups(graph, records, dataset.task);
  $('train').disabled = busy || !records.length || !groups.length;
  $('train').title = records.length
    ? groups.length
      ? 'Train wired model branches'
      : 'Wire recordings, windows and features to a model'
    : 'Import labeled recordings first';
  $('removeSelection').disabled = busy;
}
function reportFor(id) {
  const links = incomingModels(graph, id);
  if (!links.length) return {};
  const list = links.map((n) => candidates.get(n.id));
  if (list.some((c) => !c)) return { issue: 'Train every connected model branch to see its results.' };
  if (new Set(list.map((c) => c.cohort)).size !== 1)
    return {
      issue:
        'These branches use different held-out windows. Use matching evaluation windows to rank them together.'
    };
  const score = (c) => (c.recipe.task === 'classification' ? c.validation.f1 : -c.validation.rmse);
  const best = list.reduce((a, b) => (score(b) > score(a) ? b : a));
  return {
    run: {
      best: best.id,
      recipe: best.recipe,
      labels: best.labels,
      audit: best.audit,
      candidates: list.map((c) => ({ ...c, name: blockName(graph, findNode(graph, c.id)) }))
    }
  };
}
function show(id, edge = null, focus = false) {
  selected = findNode(graph, id);
  toolbar();
  const panel = $('panel'),
    links = $('connectionsList');
  panel.replaceChildren();
  links.replaceChildren();
  $('removeSelection').hidden = !selected && !edge;
  $('removeSelection').textContent = edge ? 'Disconnect wire' : 'Remove block';
  if (!selected) {
    $('panel-title').textContent = edge ? 'Selected wire' : 'Block settings';
    $('guide').textContent = edge
      ? blockName(graph, findNode(graph, edge.from)) + ' → ' + blockName(graph, findNode(graph, edge.to))
      : 'Select a block on the grid to inspect its settings and connections.';
    return;
  }
  const { type } = selected;
  config = type === 'source' ? dataset : selected.settings;
  $('inspector').dataset.tone = toneOf(type);
  $('panel-title').textContent = blockName(graph, selected);
  $('guide').textContent = stages[type]?.[1] || models[type].guide;
  for (const e of graph.edges.filter((e) => e.to === id || e.from === id)) {
    const from = blockName(graph, findNode(graph, e.from)),
      to = blockName(graph, findNode(graph, e.to));
    const chip = document.createElement('span');
    chip.className = 'connection-chip';
    chip.append(from + ' → ' + to);
    const cut = document.createElement('button');
    cut.textContent = '×';
    cut.setAttribute('aria-label', 'Disconnect ' + from + ' from ' + to);
    cut.onclick = () => editor.disconnect(e.from, e.to);
    chip.append(cut);
    links.append(chip);
  }
  if (ports[type].input.length && !inputsOf(graph, id).length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Input accepts ' +
      ports[type].input.map((k) => portNames[k]).join(' or ') +
      '. Connect an output on the grid.';
    links.append(hint);
  }
  if (type === 'source') sourcePanel(panel);
  if (type === 'scope' && inputsOf(graph, id).length)
    mountScope(panel, records, call, esc, status, (config.view ??= scopeDefaults()));
  if (type === 'windows') windowsPanel(panel);
  if (type === 'filters') filtersPanel(panel);
  if (type === 'features') featuresPanel(panel);
  if (type === 'plots') plotsPanel(panel);
  if (type === 'scale') scalePanel(panel);
  if (models[type]) modelPanel(panel, type);
  if (type === 'scores') scoresPanel(panel);
  if (type === 'live') {
    if (liveNode !== id) {
      deploy.stop();
      deploy.resetSelection();
      liveNode = id;
    }
    const { run, issue } = reportFor(id);
    deploy.mount(panel, run);
    if (issue) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = issue;
      panel.prepend(note);
    }
  }
  if (focus) {
    $('inspector').scrollIntoView({ block: 'start' });
    $('panel-title').focus({ preventScroll: true });
  }
}
function setBusy(value) {
  busy = value;
  toolbar();
  editor.render();
  $('panel').inert = value;
  $('connectionsList').inert = value;
  $('panel').setAttribute('aria-busy', String(value));
}
async function addFiles(files) {
  if (busy || !files.length) return;
  const empty = !records.length,
    errors = [];
  let count = 0;
  setBusy(true);
  try {
    for (const file of files) {
      status('Opening ' + file.name + '…');
      try {
        records.push(await call('import', { file }));
        count++;
      } catch (error) {
        errors.push(file.name + ' · ' + error.message);
      }
    }
    if (count) {
      invalidate();
      chooseInitialChannel(empty);
    }
    status(
      `${count} recording${count === 1 ? '' : 's'} imported.` +
        (errors.length ? ' ' + errors.join(' / ') : ''),
      !!errors.length
    );
  } finally {
    setBusy(false);
    show(selected.id);
  }
}
function chooseInitialChannel(empty) {
  if (!empty || !records.length) return;
  const common = records[0].channels.filter((k) => records.every((r) => r.channels.includes(k)));
  for (const n of graph.nodes.filter((n) => n.type === 'features')) {
    if (!common.includes(n.settings.channels[0]))
      n.settings.channels = [common[0] || records[0].channels[0]];
  }
}
function sourcePanel(panel) {
  const regression = config.task === 'regression';
  panel.innerHTML = `<div class="dropzone" id="drop"><span class="drop-icon" aria-hidden="true">⇩</span><strong>Drop your HDF5 recordings here</strong>
    <button id="browse" class="btn-primary">Choose recordings</button><small>PAL V2 · .h5 or .hdf5 · select multiple files</small>
    <input type="file" id="files" accept=".h5,.hdf5" multiple hidden></div>
    <div class="rubric"><label>Learning task<select id="task">${options(
      [
        ['classification', 'Classification'],
        ['regression', 'Regression']
      ],
      config.task
    )}</select></label>
    ${!records.length ? '<button id="examples">Try six example recordings</button>' : ''}</div>
    <p class="hint">${regression ? 'Use measured numeric targets, including their units in your notes.' : 'Use a shared label for repeated behaviors. Numeric labels such as 1 and 2 are treated as distinct classes.'}</p>
    ${
      records.length
        ? `<h3>Recordings</h3><div class="table-wrap"><table><thead><tr><th>File</th><th>Duration</th><th>${regression ? 'Target value' : 'Class label'}</th><th></th></tr></thead><tbody>
    ${records.map((r, i) => `<tr><td class="name-cell">${esc(r.name)}</td><td>${r.seconds.toFixed(1)} s</td><td><input data-label="${i}" aria-label="Target for ${esc(r.name)}" type="${regression ? 'number' : 'text'}" step="any" value="${esc(r.label)}" placeholder="${regression ? 'e.g. 120' : 'e.g. rotating'}"></td><td><button class="mini" data-remove="${i}" aria-label="Remove ${esc(r.name)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="note">For the class exercise, import your six recordings of roughly three minutes each. Shorter or longer trials work too. Files stay in this browser tab.</p>'
    }`;
  $('browse').onclick = () => $('files').click();
  $('files').onchange = (e) => addFiles([...e.target.files]);
  for (const type of ['dragover', 'dragleave', 'drop'])
    $('drop').addEventListener(type, (e) => {
      e.preventDefault();
      $('drop').classList.toggle('drag', type === 'dragover');
      if (type === 'drop') addFiles([...e.dataTransfer.files]);
    });
  $('task').onchange = (e) => {
    invalidate();
    config.task = e.target.value;
    show(selected.id);
  };
  panel.querySelectorAll('[data-label]').forEach(
    (el) =>
      (el.onchange = () => {
        records[el.dataset.label].label = el.value.trim();
        invalidate();
      })
  );
  panel.querySelectorAll('[data-remove]').forEach(
    (el) =>
      (el.onclick = () => {
        const [r] = records.splice(+el.dataset.remove, 1);
        send('remove', { id: r.id });
        for (const n of graph.nodes.filter((n) => n.type === 'features')) {
          n.settings.channels = n.settings.channels.filter((k) => available().includes(k));
          if (!n.settings.channels.length && records.length)
            n.settings.channels = [records[0].channels[0]];
        }
        invalidate();
        show(selected.id);
      })
  );
  if ($('examples'))
    $('examples').onclick = async () => {
      setBusy(true);
      try {
        records.push(...(await call('examples')));
        config.task = 'classification';
        chooseInitialChannel(true);
        status('Loaded six synthetic bench trials, three per behavior.');
      } catch (error) {
        status(error.message, true);
      } finally {
        setBusy(false);
        show(selected.id);
      }
    };
}
function windowsPanel(panel) {
  const time = config.split === 'time';
  panel.innerHTML = `<div class="rubric"><label>Split strategy<select id="split">${options(
    [
      ['time', 'Time blocks within each recording'],
      ['recording', 'Hold out whole recordings']
    ],
    config.split
  )}</select></label></div>
    <p class="note">${time ? 'Each file contributes consecutive train, validation, and test intervals. Windows stay inside one interval. Scores describe later moments in these same recordings.' : 'Keep each trial in one set to test generalization to another recording. With six trials and two classes, assign one trial per class to each set.'}</p>
    ${
      time
        ? `<div class="rubric"><label>Train (%)<input type="number" id="trainPct" value="${config.trainPct}" min="1" max="98"></label><label>Validation (%)<input type="number" id="validPct" value="${config.validPct}" min="1" max="98"></label><span id="testPct"></span></div>`
        : `<div class="table-wrap"><table><thead><tr><th>Recording</th><th>Label</th><th>Partition</th></tr></thead><tbody>${records.map((r, i) => `<tr><td>${esc(r.name)}</td><td>${esc(r.label)}</td><td><select data-partition="${i}" aria-label="Partition for ${esc(r.name)}">${options(partitionOptions, config.partitions[r.id] || r.partition)}</select></td></tr>`).join('')}</tbody></table></div>`
    }
    <div class="rubric"><label>Window length (s)<input type="number" id="seconds" value="${config.seconds}" min=".25" max="30" step=".25"></label>
    <label>Overlap (%)<input type="number" id="overlap" value="${config.overlap}" min="0" max="90" step="1"></label></div>
    <p class="hint" id="stride"></p>`;
  function hints() {
    if (time) $('testPct').textContent = 100 - config.trainPct - config.validPct + '% test';
    $('stride').textContent =
      'A new window starts every ' +
      (config.seconds * (1 - config.overlap / 100)).toFixed(2) +
      ' s. Incomplete windows are counted in the evaluation report.';
  }
  hints();
  $('split').onchange = (e) => {
    invalidate();
    config.split = e.target.value;
    show(selected.id);
  };
  for (const id of ['trainPct', 'validPct', 'seconds', 'overlap'])
    if ($(id))
      $(id).onchange = (e) => {
        invalidate();
        config[id] = e.target.valueAsNumber;
        hints();
      };
  panel.querySelectorAll('[data-partition]').forEach(
    (el) =>
      (el.onchange = () => {
        invalidate();
        config.partitions[records[el.dataset.partition].id] = el.value;
      })
  );
}
function available() {
  return records.length
    ? Object.keys(channels).filter((k) => records.some((r) => r.channels.includes(k)))
    : Object.keys(channels);
}
function filtersPanel(panel) {
  panel.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Response</th><th>High-pass edge (Hz)</th><th>Low-pass edge (Hz)</th></tr></thead><tbody>
    ${available()
      .map((k) => {
        const f = config.filters[k] || {
          type: 'none',
          low: 0.1,
          high: k === 'audio' ? 1000 : groups.Environment.includes(k) ? 0.25 : 20
        };
        return `<tr data-filter="${k}"><td>${channels[k][0]}</td><td><select aria-label="Filter for ${channels[k][0]}">${options(
          [
            ['none', 'Pass through'],
            ['low', 'Low-pass'],
            ['high', 'High-pass'],
            ['band', 'Band-pass']
          ],
          f.type
        )}</select></td>
    ${['low', 'high'].map((edge, i) => `<td><input aria-label="${edge} edge for ${channels[k][0]}" type="number" data-edge="${edge}" min=".0001" step="any" value="${f[edge]}" ${[i ? 'low' : 'high', 'band'].includes(f.type) ? '' : 'disabled'}></td>`).join('')}</tr>`;
      })
      .join('')}</tbody></table></div>
    <p class="hint">Only channels selected in Feature extraction feed the model. Environmental readings arrive about once per second, so their cutoff must stay below 0.5 Hz.</p>`;
  panel.querySelectorAll('[data-filter]').forEach(
    (tr) =>
      (tr.onchange = () => {
        invalidate();
        config.filters[tr.dataset.filter] = {
          type: tr.querySelector('select').value,
          low: tr.querySelector('[data-edge=low]').valueAsNumber,
          high: tr.querySelector('[data-edge=high]').valueAsNumber
        };
        filtersPanel(panel);
      })
  );
}
function featuresPanel(panel) {
  const check = (type, k, name) =>
    `<label class="check"><input type="checkbox" data-set="${type}" value="${k}" ${checked(config[type].includes(k))}>${esc(name)}</label>`;
  const availableKeys = available();
  const featureGroups = {
    'Time domain': ['mean', 'rms', 'sd', 'range'],
    'Frequency domain': ['peakHz', 'centroid'],
    'Raw waveform': ['raw']
  };
  panel.innerHTML =
    '<h3>Input channels</h3>' +
    Object.entries(groups)
      .map(([group, keys]) => {
        const present = keys.filter((k) => availableKeys.includes(k));
        return present.length
          ? `<p class="subhead">${group}</p><div class="check-grid">${present.map((k) => check('channels', k, channels[k][0])).join('')}</div>`
          : '';
      })
      .join('') +
    '<h3>Features per channel</h3>' +
    Object.entries(featureGroups)
      .map(
        ([g, keys]) =>
          `<p class="subhead">${g}</p><div class="check-grid">${keys.map((k) => check('features', k, features[k])).join('')}</div>`
      )
      .join('') +
    '<p class="hint">Frequency features use a mean-removed Hann-windowed FFT. Choose at least four seconds when using these features with 1 Hz environmental channels. Raw mode samples 32 positions in each window.</p>';
  panel.querySelectorAll('[data-set]').forEach(
    (el) =>
      (el.onchange = () => {
        invalidate();
        const set = el.dataset.set;
        config[set] = [...panel.querySelectorAll(`[data-set="${set}"]:checked`)].map(
          (input) => input.value
        );
      })
  );
}
function plotsPanel(panel) {
  const data = branch(graph, selected.id, records, dataset.task);
  if (!data.table || data.missing) {
    panel.innerHTML =
      '<p class="note">Wire a complete feature table to this block to explore its training windows.</p>';
    return;
  }
  const { table, recipe } = data;
  const scopedCall = (action, payload) => call(action, { ...payload, table });
  mountPlots(
    panel,
    previews.get(table),
    recipe,
    scopedCall,
    esc,
    status,
    (config.view ??= plotDefaults()),
    async () => {
      setBusy(true);
      try {
        previews.set(table, await call('preview', data));
        plotsPanel(panel);
        status('Feature plots ready.');
      } catch (error) {
        status(error.message, true);
      } finally {
        setBusy(false);
      }
    }
  );
}
function scalePanel(panel) {
  panel.innerHTML = `<div class="rubric"><label>Feature scaling<select id="scale">${options(
    [
      ['standard', 'Standard score'],
      ['minmax', 'Min–max'],
      ['none', 'Pass through']
    ],
    config.scale
  )}</select></label></div>
    <p class="note">Standard scores subtract the training mean and divide by its standard deviation. Min–max scaling uses the training minimum and range. A constant training feature uses a divisor of one.</p>`;
  $('scale').onchange = (e) => {
    invalidate();
    config.scale = e.target.value;
  };
}
function modelPanel(panel, k) {
  const m = models[k];
  panel.innerHTML = `<div class="rubric"><label>${m.param}<input id="param" type="number" min="${m.min}" max="${m.max}" step="${m.step}" value="${config.param}"></label></div><p class="hint">Supported range ${m.min}–${m.max}. Wire this output to Compare models to evaluate it alongside other models.</p>`;
  $('param').onchange = (e) => {
    invalidate();
    config.param = e.target.valueAsNumber;
  };
}
function scoresPanel(panel) {
  const { run, issue } = reportFor(selected.id);
  if (issue) {
    panel.innerHTML = '<p class="note">' + esc(issue) + '</p>';
    return;
  }
  if (!run) {
    panel.innerHTML =
      '<p class="note">Import labeled recordings and train the pipeline to compare validation scores.</p>';
    return;
  }
  const classification = run.recipe.task === 'classification',
    metrics = classification ? ['accuracy', 'precision', 'recall', 'f1', 'auc'] : ['mae', 'rmse', 'r2'];
  const names = {
    accuracy: 'Accuracy',
    precision: 'Precision',
    recall: 'Recall',
    f1: 'F1',
    auc: 'ROC AUC',
    mae: 'MAE',
    rmse: 'RMSE',
    r2: 'R²'
  };
  const table = (
    test
  ) => `<div class="table-wrap"><table><thead><tr><th>Model</th>${metrics.map((k) => '<th>' + names[k] + '</th>').join('')}</tr></thead><tbody>
    ${run.candidates
      .map((c) => {
        const scores = test ? testScores[c.id] : c.validation;
        return `<tr><td>${esc(c.name)}</td>${metrics.map((k) => '<td>' + (scores[k] === null ? '—' : scores[k].toFixed(3)) + '</td>').join('')}</tr>`;
      })
      .join('')}</tbody></table></div>`;
  const best = blockName(graph, findNode(graph, run.best));
  const tested = revealed.has(selected.id) && run.candidates.every((c) => testScores[c.id]);
  panel.innerHTML = `<div class="result"><strong class="prediction-best">${best}</strong> selected by ${classification ? 'highest validation macro F1' : 'lowest validation RMSE'}.</div>
    <h3>Validation</h3>${table(false)}<p class="hint">${classification ? 'Precision, recall and F1 are macro averages. ROC AUC ranks class scores one versus the rest. A dash means a class lacks positive or negative examples.' : 'MAE and RMSE are in the target’s units. R² is undefined for a constant evaluation target.'}</p>
    <h3>Held-out test</h3>${tested ? table(true) : '<button id="test">Reveal test scores</button>'}
    ${tested && classification ? `<h3>Test confusion matrix · ${best}</h3><div class="table-wrap"><table><thead><tr><th>Actual ↓ / predicted →</th>${run.labels.map((v) => '<th>' + esc(v) + '</th>').join('')}</tr></thead><tbody>${testScores[run.best].matrix.map((row, i) => '<tr><th>' + esc(run.labels[i]) + '</th>' + row.map((n) => '<td>' + n + '</td>').join('') + '</tr>').join('')}</tbody></table></div>` : ''}
    <details class="quality" open><summary>Window counts by recording</summary><div class="table-wrap"><table><thead><tr><th>Recording</th><th>Train</th><th>Validation</th><th>Test</th><th>Skipped</th></tr></thead>
    <tbody>${run.audit.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.train}</td><td>${r.validation}</td><td>${r.test}</td><td>${r.skipped}</td></tr>`).join('')}</tbody></table></div><p class="hint">Skipped windows contain gaps, missing channels within the interval, or too few samples for a selected feature. Short tails at partition boundaries are discarded.</p></details>`;
  if ($('test'))
    $('test').onclick = async () => {
      setBusy(true);
      try {
        Object.assign(testScores, await call('test', { ids: run.candidates.map((c) => c.id) }));
        revealed.add(selected.id);
        scoresPanel(panel);
        status('Test scores ready.');
      } catch (error) {
        status(error.message, true);
      } finally {
        setBusy(false);
      }
    };
}
$('train').onclick = async () => {
  const groups = trainingGroups(graph, records, dataset.task);
  if (!groups.length || busy) return;
  invalidate();
  setBusy(true);
  try {
    const result = await call('train', { groups });
    deploy.resetSelection();
    candidates = new Map(result.candidates.map((c) => [c.id, c]));
    previews = new Map(Object.entries(result.tables));
    const report = graph.nodes.find(
      (n) => n.type === 'scores' && inputsOf(graph, n.id).some((m) => candidates.has(m.id))
    );
    editor.select(report?.id || result.candidates[0].id, true);
    const count = result.candidates.length,
      total = graph.nodes.filter((n) => models[n.type]).length;
    status(
      'Training complete · ' +
        count +
        ' of ' +
        total +
        ' model blocks trained.' +
        (count < total ? ' Wire the remaining models to a complete feature table to include them.' : '')
    );
  } catch (error) {
    status(error.message, true);
    show(selected?.id);
  } finally {
    setBusy(false);
  }
};
editor = graphEditor(graph, {
  onSelect: show,
  onChange: topologyChanged,
  describe,
  status,
  isBusy: () => busy
});
signature = computationWires();
wiring = JSON.stringify(graph.edges);
show(selected.id);
