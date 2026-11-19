import { fitChart } from './chart-size.js';
const fmt = (n) =>
  n !== 0 && (Math.abs(n) < 0.001 || Math.abs(n) >= 1e6)
    ? n.toExponential(2)
    : Number(n.toPrecision(4)).toString();
export const plotDefaults = () => ({ view: 'distribution', x: 1, y: 0, record: -1, scaled: false });
let revision = 0;
const option = (v, label, selected, esc) =>
  `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(label)}</option>`;
function quantile(sorted, p) {
  const n = (sorted.length - 1) * p,
    i = Math.floor(n);
  return sorted[i] + (sorted[Math.ceil(n)] - sorted[i]) * (n - i);
}
export function mountPlots(panel, meta, recipe, call, esc, status, s, extract) {
  if (!meta) {
    panel.innerHTML =
      '<p class="note">Extract the selected features to see one measurement per training window. You can explore a single recording before fitting any models.</p><button class="btn-primary" id="extract">Extract &amp; plot features</button>';
    panel.querySelector('#extract').onclick = extract;
    return;
  }
  const { columns, files } = meta;
  if (!columns[s.x]) s.x = 0;
  if (!columns[s.y]) s.y = recipe.task === 'regression' ? -1 : Math.min(1, columns.length - 1);
  if (!meta.trainingFiles.includes(s.record)) s.record = -1;
  const featureOptions = (selected) => columns.map((c, i) => option(i, c.name, selected, esc)).join('');
  panel.innerHTML = `<div class="rubric"><label>Plot type<select id="view">${[
    ['distribution', 'Distributions by label'],
    ['scatter', 'Feature scatter'],
    ['trend', 'Feature over time']
  ]
    .map(([v, t]) => option(v, t, s.view, esc))
    .join('')}</select></label>
    <label>Recordings<select id="record">${option(-1, 'All training recordings', s.record, esc) + meta.trainingFiles.map((i) => option(i, files[i].name, s.record, esc)).join('')}</select></label></div>
    <div class="rubric"><label>${s.view === 'scatter' ? 'Horizontal feature' : 'Feature'}<select id="featureX">${featureOptions(s.x)}</select></label>
    ${s.view === 'scatter' ? `<label>Vertical feature<select id="featureY">${(recipe.task === 'regression' ? option(-1, 'Numeric target', s.y, esc) : '') + featureOptions(s.y)}</select></label>` : ''}
    <label class="check"><input type="checkbox" id="scaled" ${s.scaled && recipe.scale !== 'none' ? 'checked' : ''} ${recipe.scale === 'none' ? 'disabled' : ''}>Model-scaled values</label></div>
    <div id="featuresLegend" class="legend"></div><canvas id="featuresPlot" aria-label="Extracted features of training windows" aria-describedby="featuresNote"></canvas>
    <p class="hint" id="featuresNote"></p><details><summary>Feature values by label</summary><div class="table-wrap" id="featureStats"></div></details>`;
  const find = (id) => panel.querySelector('#' + id);
  const remount = () => mountPlots(panel, meta, recipe, call, esc, status, s, extract);
  for (const [id, k] of [
    ['view', 'view'],
    ['record', 'record'],
    ['featureX', 'x'],
    ['featureY', 'y'],
    ['scaled', 'scaled']
  ])
    if (find(id))
      find(id).onchange = (e) => {
        s[k] =
          k === 'view' ? e.target.value : k === 'scaled' ? e.target.checked : Number(e.target.value);
        remount();
      };
  const canvas = find('featuresPlot'),
    token = ++revision,
    scaled = s.scaled && recipe.scale !== 'none';
  call('columns', { x: s.x, y: s.y, scaled, record: s.record })
    .then((points) => {
      if (!canvas.isConnected || token !== revision) return;
      const unit = (i) => (scaled ? 'scaled units' : columns[i].unit);
      const xLabel = columns[s.x].name + ' (' + unit(s.x) + ')';
      const yLabel = s.y === -1 ? 'Target value' : columns[s.y].name + ' (' + unit(s.y) + ')';
      const labels = [...new Set(files.map((f) => f.label || 'Unlabeled'))];
      const active = new Map();
      for (const pt of points) {
        const label = files[pt.record].label || 'Unlabeled';
        if (!active.has(label)) active.set(label, []);
        active.get(label).push(pt);
      }
      const css = getComputedStyle(canvas);
      const palette = ['--x', '--y', '--ok', '--z', '--accent', '--t-usb', '--t-audio', '--warn'].map(
        (k) => css.getPropertyValue(k).trim()
      );
      const series = [...active].map(([label, pts]) => {
        const sorted = pts.map((p) => p.x).sort((a, b) => a - b);
        return {
          label,
          pts,
          color: palette[labels.indexOf(label) % palette.length],
          q: [0, 0.25, 0.5, 0.75, 1].map((p) => quantile(sorted, p))
        };
      });
      find('featuresLegend').innerHTML = series
        .map((g) => `<span><b style="color:${g.color}">●</b> ${esc(g.label)} · ${g.pts.length}</span>`)
        .join('');
      find('featuresNote').textContent =
        `${points.length} training windows shown · ${meta.skipped} incomplete training windows skipped across the dataset. ` +
        {
          distribution:
            'Boxes span the middle 50% of windows. The center line is the median and whiskers span the observed range.',
          scatter:
            'Each dot is one window. Overlapping colors suggest these two features alone may have difficulty separating behaviors.',
          trend:
            'Each line follows one recording. Time is measured from its first sample. Gaps interrupt the line.'
        }[s.view];
      find('featureStats').innerHTML =
        `<table><thead><tr><th>Label</th><th>Windows</th><th>Minimum</th><th>Median</th><th>Maximum</th></tr></thead><tbody>${series.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.pts.length}</td><td>${fmt(g.q[0])}</td><td>${fmt(g.q[2])}</td><td>${fmt(g.q[4])}</td></tr>`).join('')}</tbody></table>`;
      fitChart(canvas, () =>
        paint(canvas, series, s.view, xLabel, yLabel, recipe.seconds * (1 - recipe.overlap / 100))
      );
    })
    .catch((e) => status(e.message, true));
}
function paint(canvas, series, view, xLabel, yLabel, hop) {
  const height = view === 'distribution' ? Math.max(220, series.length * 43 + 100) : 320;
  canvas.style.height = height + 'px';
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    dpr = devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(canvas),
    ink = css.getPropertyValue('--lab-muted'),
    line = css.getPropertyValue('--lab-line');
  const box = view === 'distribution',
    trend = view === 'trend',
    left = box ? Math.min(110, w * 0.28) : 65,
    right = w - 22,
    top = 30,
    bottom = h - 52;
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity;
  for (const g of series)
    for (const p of g.pts) {
      const x = trend ? p.seconds : p.x,
        y = trend ? p.x : p.y;
      if (!box && !Number.isFinite(y)) continue;
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      if (!box) {
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
    }
  ctx.fillStyle = ink;
  ctx.font = '12px system-ui';
  if (!Number.isFinite(xmin)) {
    ctx.fillText('No eligible training windows for this selection', 12, h / 2);
    return;
  }
  function bounds(lo, hi) {
    const pad = (hi - lo) * 0.05 || Math.max(0.01, Math.abs(lo) * 0.04);
    return [lo - pad, hi + pad];
  }
  [xmin, xmax] = bounds(xmin, xmax);
  if (!box) [ymin, ymax] = bounds(ymin, ymax);
  const X = (v) => left + ((v - xmin) / (xmax - xmin)) * (right - left),
    Y = (v) => bottom - ((v - ymin) / (ymax - ymin)) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const x = xmin + ((xmax - xmin) * i) / 4,
      y = ymin + ((ymax - ymin) * i) / 4;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(X(x), top);
    ctx.lineTo(X(x), bottom);
    if (!box) {
      ctx.moveTo(left, Y(y));
      ctx.lineTo(right, Y(y));
      ctx.textAlign = 'right';
      ctx.fillText(fmt(y), left - 8, Y(y) + 4);
    }
    ctx.stroke();
    ctx.textAlign = 'center';
    const label = fmt(x),
      half = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.min(w - half - 3, Math.max(half + 3, X(x))), bottom + 16);
  }
  ctx.fillText(trend ? 'Window start (s)' : xLabel, (left + right) / 2, h - 9, w - 12);
  ctx.textAlign = 'left';
  if (!box) ctx.fillText(trend ? xLabel : yLabel, 8, 16, w - 16);
  series.forEach((g, i) => {
    ctx.fillStyle = ctx.strokeStyle = g.color;
    ctx.lineWidth = 1.65;
    if (box) {
      const y = top + ((i + 0.5) * (bottom - top)) / series.length,
        [min, q1, median, q3, max] = g.q.map(X);
      ctx.textAlign = 'right';
      ctx.fillText(g.label, left - 9, y + 4, left - 14);
      ctx.textAlign = 'left';
      ctx.beginPath();
      ctx.moveTo(min, y);
      ctx.lineTo(max, y);
      ctx.moveTo(min, y - 5);
      ctx.lineTo(min, y + 5);
      ctx.moveTo(max, y - 5);
      ctx.lineTo(max, y + 5);
      ctx.stroke();
      ctx.globalAlpha = 0.32;
      ctx.fillRect(q1, y - 10, Math.max(1, q3 - q1), 20);
      ctx.globalAlpha = 1;
      ctx.strokeRect(q1, y - 10, Math.max(1, q3 - q1), 20);
      ctx.beginPath();
      ctx.moveTo(median, y - 10);
      ctx.lineTo(median, y + 10);
      ctx.stroke();
    } else {
      let last;
      ctx.beginPath();
      for (const p of g.pts) {
        const y = trend ? p.x : p.y;
        if (!Number.isFinite(y)) continue;
        const px = X(trend ? p.seconds : p.x),
          py = Y(y);
        if (trend && last?.record === p.record && p.seconds - last.seconds < hop * 1.25)
          ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        if (!trend || g.pts.length < 150) ctx.fillRect(px - 1.4, py - 1.4, 2.8, 2.8);
        last = p;
      }
      if (trend) ctx.stroke();
    }
  });
}
