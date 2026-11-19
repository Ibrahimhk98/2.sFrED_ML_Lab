import { fitChart } from './chart-size.js';
import { channels } from './catalog.js';

export const scopeDefaults = () => ({
  first: '',
  second: '',
  key: 'ax',
  start: 0,
  seconds: 2,
  domain: 'time'
});
let drawing = 0;
export function mountScope(panel, records, call, esc, status, s) {
  if (!records.length) {
    panel.innerHTML = '<p class="note">Import a recording to inspect its signals.</p>';
    return;
  }
  if (!records.some((r) => r.id === s.first)) s.first = records[0].id;
  if (!records.some((r) => r.id === s.second)) s.second = '';
  const first = records.find((r) => r.id === s.first);
  if (!first.channels.includes(s.key)) s.key = first.channels[0];
  const options = (items, selected) =>
    items
      .map(
        ([id, name]) =>
          `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(name)}</option>`
      )
      .join('');
  const maxSeconds = s.domain === 'fft' ? Math.min(30, first.seconds) : first.seconds;
  const files = records.map((r) => [r.id, r.name + (r.label ? ' · ' + r.label : '')]);
  panel.innerHTML = `<div class="rubric"><label>Recording<select id="first">${options(files, s.first)}</select></label>
    <label>Compare with<select id="second">${options([['', 'No overlay'], ...files.filter(([id]) => id !== s.first)], s.second)}</select></label></div>
    <div class="rubric"><label>Channel<select id="key">${options(
      first.channels.map((k) => [k, channels[k][0]]),
      s.key
    )}</select></label>
    <label>Domain<select id="domain">${options(
      [
        ['time', 'Time waveform'],
        ['fft', 'Frequency · FFT']
      ],
      s.domain
    )}</select></label>
    <label>Start (s)<input id="scope-start" type="number" min="0" step="0.01" value="${s.start}"></label>
    <label>Window (s)<input id="scope-seconds" type="number" min="0.01" max="${maxSeconds}" step="0.01" value="${s.seconds}"></label>
    ${s.domain === 'time' ? '<button id="fitScope">Fit recording</button>' : ''}</div>
    <div class="legend" id="legend"></div><canvas id="plot" aria-label="Selected recording signals"></canvas>
    <label class="timeline">Pan through recording<input id="pan" type="range" min="0" step=".01"></label><p class="hint" id="plot-note"></p>`;
  const el = (id) => panel.querySelector('#' + id);
  let fetching = false,
    dirty = false;
  const redraw = async () => {
    if (fetching) {
      dirty = true;
      return;
    }
    fetching = true;
    const canvas = el('plot'),
      token = ++drawing;
    s.seconds = Math.max(0.01, Math.min(maxSeconds, Number(el('scope-seconds').value) || 2));
    const max = Math.max(0, first.seconds - s.seconds);
    s.start = Math.min(max, Math.max(0, Number(el('scope-start').value) || 0));
    el('scope-start').value = s.start;
    el('scope-seconds').value = s.seconds;
    el('pan').max = max;
    el('pan').value = s.start;
    const ids = [s.first, ...(s.second ? [s.second] : [])];
    try {
      const traces = await call('trace', {
        ids,
        key: s.key,
        start: s.start,
        seconds: s.seconds,
        domain: s.domain
      });
      if (!canvas.isConnected || drawing !== token) return;
      el('legend').innerHTML = ids
        .map(
          (id, i) =>
            `<span><b class="${i ? 'compare' : ''}">━</b> ${esc(files.find((f) => f[0] === id)[1])}</span>`
        )
        .join('');
      el('plot-note').textContent =
        traces
          .map((t, i) => (t.note ? files.find((f) => f[0] === ids[i])[1] + ' · ' + t.note : ''))
          .filter(Boolean)
          .join(' / ') ||
        (s.domain === 'time'
          ? 'Time is relative to the first sample in each file. Gaps interrupt the trace.'
          : 'FFT supports intervals up to 30 s. The single-sided spectrum uses a Hann window after removing the mean.');
      fitChart(canvas, () => paint(canvas, traces, s));
    } catch (e) {
      status(e.message, true);
    } finally {
      fetching = false;
      if (dirty && canvas.isConnected) {
        dirty = false;
        redraw();
      }
    }
  };
  for (const key of ['first', 'second', 'key', 'domain'])
    el(key).onchange = (e) => {
      s[key] = e.target.value;
      if (s.first === s.second) s.second = '';
      mountScope(panel, records, call, esc, status, s);
    };
  if (el('fitScope'))
    el('fitScope').onclick = () => {
      el('scope-start').value = 0;
      el('scope-seconds').value = first.seconds;
      redraw();
    };
  el('pan').oninput = (e) => {
    el('scope-start').value = e.target.value;
    redraw();
  };
  el('scope-start').onchange = el('scope-seconds').onchange = redraw;
  redraw();
}
function paint(canvas, traces, s) {
  const css = getComputedStyle(canvas),
    palette = ['--lab-accent', '--lab-amber'].map((k) => css.getPropertyValue(k).trim());
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    dpr = devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const left = 57,
    right = w - 18,
    top = 23,
    bottom = h - 35;
  const time = s.domain === 'time',
    xmin = time ? s.start : 0,
    xmax = time ? s.start + s.seconds : Math.max(1, ...traces.map((t) => t.nyquist || 0));
  let lo = Infinity,
    hi = -Infinity;
  for (const t of traces)
    for (const p of t.points)
      if (p) {
        lo = Math.min(lo, p[1]);
        hi = Math.max(hi, p[1]);
      }
  const empty = !Number.isFinite(lo);
  if (empty) {
    lo = -1;
    hi = 1;
  } else if (lo === hi) {
    lo -= 0.01;
    hi += 0.01;
  } else {
    const pad = (hi - lo) * 0.06;
    hi += pad;
    lo -= pad;
  }
  const x = (v) => left + ((v - xmin) / (xmax - xmin)) * (right - left),
    y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  ctx.font = '11px system-ui';
  ctx.fillStyle = css.getPropertyValue('--lab-muted');
  ctx.fillText(channels[s.key][1], 5, 14);
  for (let i = 0; i <= 4; i++) {
    const t = xmin + ((xmax - xmin) * i) / 4,
      v = lo + ((hi - lo) * i) / 4;
    ctx.strokeStyle = css.getPropertyValue('--lab-line');
    ctx.beginPath();
    ctx.moveTo(left, y(v));
    ctx.lineTo(right, y(v));
    ctx.moveTo(x(t), top);
    ctx.lineTo(x(t), bottom);
    ctx.stroke();
    ctx.fillText(Number(v.toPrecision(3)).toString(), 3, y(v) + 4);
    ctx.fillText(
      Number(t.toPrecision(4)) + (time ? ' s' : ' Hz'),
      Math.min(right - 30, x(t) - 6),
      h - 10
    );
  }
  traces.forEach((trace, i) => {
    ctx.strokeStyle = ctx.fillStyle = palette[i];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let gap = true;
    for (const p of trace.points) {
      if (!p) {
        gap = true;
        continue;
      }
      if (gap) ctx.moveTo(x(p[0]), y(p[1]));
      else ctx.lineTo(x(p[0]), y(p[1]));
      gap = false;
    }
    ctx.stroke();
    if (trace.points.length < 80)
      for (const p of trace.points)
        if (p) {
          ctx.beginPath();
          ctx.arc(x(p[0]), y(p[1]), 2, 0, 2 * Math.PI);
          ctx.fill();
        }
  });
  if (empty) {
    ctx.fillStyle = css.getPropertyValue('--lab-muted');
    ctx.fillText('No continuous signal in this interval', left + 14, top + 22);
  }
}
