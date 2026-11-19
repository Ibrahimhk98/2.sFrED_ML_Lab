import { FFT } from '../vendor/lab-math.js';
import { channels, groupOf } from './catalog.js';

const periodOf = (key) => (groupOf(key) === 'imu' ? 1000 / 104 : 1000);
const frameEnd = (frame) => frame.time_ms + (frame.pcm.length * 1000) / frame.rate;

export function indexSession(session) {
  const available = [],
    bounds = [Infinity, -Infinity];
  let longestFrame = 0;
  for (const group of ['audio', 'imu', 'environment']) {
    const rows = session[group];
    if (!rows.length) continue;
    rows.sort((a, b) => a.time_ms - b.time_ms);
    bounds[0] = Math.min(bounds[0], rows[0].time_ms);
    for (const key of Object.keys(channels).filter((k) => groupOf(k) === group)) {
      if (group === 'audio' || rows.some((r) => Number.isFinite(r[key]))) available.push(key);
    }
    if (group === 'audio') {
      for (const f of rows) {
        longestFrame = Math.max(longestFrame, (f.pcm.length * 1000) / f.rate);
        bounds[1] = Math.max(bounds[1], frameEnd(f));
      }
    } else {
      bounds[1] = Math.max(bounds[1], rows.at(-1).time_ms + (group === 'imu' ? 1000 / 104 : 1000));
    }
  }
  return { session, available, bounds, longestFrame };
}
function lowerBound(rows, t) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].time_ms < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Emit each sample with its device timestamp. A segment break survives plotting,
// and makes a window ineligible for a fixed-rate FFT or model.
function visit(source, key, start, end, emit) {
  const rows = source.session[groupOf(key)];
  let previous;
  if (key === 'audio') {
    for (let i = lowerBound(rows, start - source.longestFrame); i < rows.length; i++) {
      const f = rows[i];
      if (f.time_ms >= end) break;
      if (frameEnd(f) <= start) continue;
      const gap =
        previous &&
        (Math.abs(f.time_ms - frameEnd(previous)) > 2 ||
          f.rate !== previous.rate ||
          f.stream_id !== previous.stream_id ||
          f.segment !== previous.segment ||
          (Number.isFinite(f.sequence) && f.sequence !== previous.sequence + 1));
      const from = Math.max(0, Math.ceil(((start - f.time_ms) * f.rate) / 1000));
      const to = Math.min(f.pcm.length, Math.ceil(((end - f.time_ms) * f.rate) / 1000));
      for (let j = from; j < to; j++)
        emit(f.time_ms + (j * 1000) / f.rate, f.pcm[j] / 32768, j === from && gap, f.rate);
      previous = f;
    }
  } else {
    const maxGap = periodOf(key) * 2.75;
    let missing = false;
    for (let i = lowerBound(rows, start); i < rows.length && rows[i].time_ms < end; i++) {
      const row = rows[i];
      if (!Number.isFinite(row[key])) {
        missing = true;
        continue;
      }
      // HDF5 stores sensor readings as float32. Use that same precision for
      // live packets so tiny representation differences cannot change a feature.
      emit(
        row.time_ms,
        Math.fround(row[key]),
        missing || (previous && row.time_ms - previous.time_ms > maxGap)
      );
      previous = row;
      missing = false;
    }
  }
}
export function waveform(source, key, start, end, columns = 800) {
  const points = [];
  let bucket = -1,
    min,
    max;
  function flush() {
    if (!min) return;
    points.push(...(min[0] <= max[0] ? [min, max] : [max, min]));
    min = max = null;
  }
  visit(source, key, start, end, (t, v, gap) => {
    const column = Math.floor(((t - start) / (end - start)) * columns);
    if (column !== bucket || gap) {
      flush();
      if (gap) points.push(null);
      bucket = column;
    }
    const point = [(t - source.bounds[0]) / 1000, v];
    if (!min || v < min[1]) min = point;
    if (!max || v >= max[1]) max = point;
  });
  flush();
  return points;
}
export function uniformWindow(source, key, start, end) {
  const audio = key === 'audio',
    values = [],
    times = [];
  let broken = false,
    rate,
    first,
    last;
  visit(source, key, start, end, (t, v, gap, hz) => {
    if (gap) broken = true;
    first ??= t;
    last = t;
    rate = hz;
    values.push(v);
    if (!audio) times.push(t);
  });
  if (!values.length || broken) return null;
  const tolerance = audio ? Math.max(2, 1000 / rate) : periodOf(key) * 1.45;
  if (first - start > tolerance || end - last > tolerance) return null;
  if (audio) return { values, rate, observations: values.length };
  // Interpolate timestamped sensor samples onto a uniform grid. Endpoints use
  // the nearest in-window reading, so a held-out interval never supplies data.
  rate = 1000 / periodOf(key);
  const count = Math.max(1, Math.round(((end - start) * rate) / 1000));
  if (values.length < Math.floor(count * 0.75)) return null;
  const uniform = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = start + (i * 1000) / rate;
    while (j + 1 < times.length && times[j + 1] <= t) j++;
    const k = Math.min(j + 1, times.length - 1);
    const mix = Math.max(0, Math.min(1, (t - times[j]) / (times[k] - times[j] || 1)));
    uniform[i] = values[j] + (values[k] - values[j]) * mix;
  }
  return { values: uniform, rate, observations: values.length };
}

// Bilinear-transform second-order Butterworth sections.
function biquad(values, rate, cutoff, highpass) {
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff >= rate / 2)
    throw new Error(`Choose a cutoff between 0 and ${(rate / 2).toFixed(2)} Hz for this channel.`);
  const k = Math.tan((Math.PI * cutoff) / rate),
    norm = 1 / (1 + Math.SQRT2 * k + k * k);
  const b0 = highpass ? norm : k * k * norm,
    b1 = (highpass ? -2 : 2) * b0;
  const a1 = 2 * (k * k - 1) * norm,
    a2 = (1 - Math.SQRT2 * k + k * k) * norm;
  let x1 = values[0],
    x2 = x1,
    y1 = highpass ? 0 : x1,
    y2 = y1;
  return Float64Array.from(values, (x) => {
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  });
}
export function filterSignal(values, rate, filter) {
  if (!filter || filter.type === 'none') return values;
  if (filter.type === 'band' && filter.low >= filter.high)
    throw new Error('The lower band edge must be below the upper edge.');
  if (filter.type === 'high' || filter.type === 'band') values = biquad(values, rate, filter.low, true);
  if (filter.type === 'low' || filter.type === 'band') values = biquad(values, rate, filter.high, false);
  return values;
}
export function spectrum(values, rate) {
  if (values.length < 4) return null;
  const n = 2 ** Math.ceil(Math.log2(values.length)),
    fft = new FFT(n);
  const input = new Float64Array(n),
    complex = new Float64Array(2 * n);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let gain = 0;
  for (let i = 0; i < values.length; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (values.length - 1));
    input[i] = (values[i] - mean) * hann;
    gain += hann;
  }
  fft.realTransform(complex, input);
  const amplitudes = Float64Array.from(
    { length: n / 2 + 1 },
    (_, i) => (Math.hypot(complex[2 * i], complex[2 * i + 1]) * (i === 0 || i === n / 2 ? 1 : 2)) / gain
  );
  return { amplitudes, binHz: rate / n };
}
export function featureRow(source, start, recipe) {
  const out = [];
  const end = start + recipe.seconds * 1000;
  for (const key of recipe.channels) {
    const frame = uniformWindow(source, key, start, end);
    if (!frame) return null;
    let v;
    try {
      v = filterSignal(frame.values, frame.rate, recipe.filters[key]);
    } catch (error) {
      throw new Error(channels[key][0] + ' · ' + error.message);
    }
    let mean = 0,
      variance = 0,
      squares = 0,
      lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < v.length; i++) {
      const value = v[i],
        delta = value - mean;
      mean += delta / (i + 1);
      variance += delta * (value - mean);
      squares += value * value;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
    const result = {
      mean,
      rms: Math.sqrt(squares / v.length),
      sd: Math.sqrt(Math.max(0, variance / v.length)),
      range: hi - lo
    };
    if (recipe.features.includes('peakHz') || recipe.features.includes('centroid')) {
      const spec = frame.observations >= 4 && spectrum(v, frame.rate);
      if (!spec) return null;
      let peak = 0,
        weight = 0,
        weighted = 0;
      for (let i = 1; i < spec.amplitudes.length; i++) {
        const a = spec.amplitudes[i];
        if (a > spec.amplitudes[peak] || (peak === 0 && a > 0)) peak = i;
        weight += a;
        weighted += i * a;
      }
      result.peakHz = peak * spec.binHz;
      result.centroid = weight ? (weighted * spec.binHz) / weight : 0;
    }
    for (const name of recipe.features) {
      if (name === 'raw')
        for (let j = 0; j < 32; j++) out.push(v[Math.round((j * (v.length - 1)) / 31)]);
      else out.push(result[name]);
    }
  }
  return out;
}
