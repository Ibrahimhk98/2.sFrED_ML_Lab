import { FFT } from '../vendor/lab-math.js';
import { channels, groupOf, spectralFeatures } from './catalog.js';

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
  if (key === 'audio') {
    const rows = source.session.audio;
    const slices = [];
    let previous,
      rate,
      first,
      last,
      total = 0;
    for (let i = lowerBound(rows, start - source.longestFrame); i < rows.length; i++) {
      const f = rows[i];
      if (f.time_ms >= end) break;
      if (frameEnd(f) <= start) continue;
      if (
        previous &&
        (Math.abs(f.time_ms - frameEnd(previous)) > 2 ||
          f.rate !== previous.rate ||
          f.stream_id !== previous.stream_id ||
          f.segment !== previous.segment ||
          (Number.isFinite(f.sequence) && f.sequence !== previous.sequence + 1))
      )
        return null;
      const from = Math.max(0, Math.ceil(((start - f.time_ms) * f.rate) / 1000));
      const to = Math.min(f.pcm.length, Math.ceil(((end - f.time_ms) * f.rate) / 1000));
      if (from < to) {
        if (first === undefined) first = f.time_ms + (from * 1000) / f.rate;
        last = f.time_ms + ((to - 1) * 1000) / f.rate;
        rate = f.rate;
        slices.push([f.pcm, from, to]);
        total += to - from;
      }
      previous = f;
    }
    if (!total) return null;
    const tolerance = Math.max(2, 1000 / rate);
    if (first - start > tolerance || end - last > tolerance) return null;
    const values = new Float64Array(total);
    let offset = 0;
    for (const [pcm, from, to] of slices) {
      for (let j = from; j < to; j++) values[offset++] = pcm[j] / 32768;
    }
    return { values, rate, observations: total };
  }
  const values = [],
    times = [];
  let broken = false,
    first,
    last;
  visit(source, key, start, end, (t, v, gap) => {
    if (gap) broken = true;
    first ??= t;
    last = t;
    values.push(v);
    times.push(t);
  });
  if (!values.length || broken) return null;
  const tolerance = periodOf(key) * 1.45;
  if (first - start > tolerance || end - last > tolerance) return null;
  // Interpolate timestamped sensor samples onto a uniform grid. Endpoints use
  // the nearest in-window reading, so a held-out interval never supplies data.
  const rate = 1000 / periodOf(key);
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
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}
export function filterSignal(values, rate, filter) {
  if (!filter || filter.type === 'none') return values;
  if (filter.type === 'band' && filter.low >= filter.high)
    throw new Error('The lower band edge must be below the upper edge.');
  if (filter.type === 'high' || filter.type === 'band') values = biquad(values, rate, filter.low, true);
  if (filter.type === 'low' || filter.type === 'band') values = biquad(values, rate, filter.high, false);
  return values;
}
const fftCache = new Map();
const hannCache = new Map();

function getFft(n) {
  let entry = fftCache.get(n);
  if (!entry) {
    if (fftCache.size >= 16) fftCache.clear();
    entry = { fft: new FFT(n), input: new Float64Array(n), complex: new Float64Array(2 * n) };
    fftCache.set(n, entry);
  }
  return entry;
}
function getHann(length) {
  let entry = hannCache.get(length);
  if (!entry) {
    if (hannCache.size >= 32) hannCache.clear();
    const weights = new Float64Array(length);
    const scale = (2 * Math.PI) / (length - 1);
    let gain = 0;
    for (let i = 0; i < length; i++) {
      const h = 0.5 - 0.5 * Math.cos(scale * i);
      weights[i] = h;
      gain += h;
    }
    entry = { weights, gain };
    hannCache.set(length, entry);
  }
  return entry;
}
export function spectrum(values, rate) {
  if (values.length < 4) return null;
  const len = values.length;
  const n = 2 ** Math.ceil(Math.log2(len));
  const { fft, input, complex } = getFft(n);
  const { weights, gain } = getHann(len);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += values[i];
  const mean = sum / len;
  for (let i = 0; i < len; i++) input[i] = (values[i] - mean) * weights[i];
  if (len < n) input.fill(0, len);
  fft.realTransform(complex, input);
  const half = n / 2;
  const amplitudes = new Float64Array(half + 1);
  const invGain = 1 / gain;
  const invGain2 = 2 / gain;
  amplitudes[0] = Math.hypot(complex[0], complex[1]) * invGain;
  for (let i = 1; i < half; i++) {
    amplitudes[i] = Math.hypot(complex[2 * i], complex[2 * i + 1]) * invGain2;
  }
  amplitudes[half] = Math.hypot(complex[n], complex[n + 1]) * invGain;
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
    if (recipe.features.some((f) => spectralFeatures.includes(f))) {
      const spec = frame.observations >= 4 && spectrum(v, frame.rate);
      if (!spec) return null;
      const amps = spec.amplitudes;
      const m = amps.length - 1;
      const wantBandwidth = recipe.features.includes('bandwidth');
      const wantRolloff = recipe.features.includes('rolloff');
      const wantFlatness = recipe.features.includes('flatness');
      const wantEntropy = recipe.features.includes('entropy');
      let peak = 0,
        weight = 0,
        weighted = 0,
        energy = 0,
        logSum = 0;
      for (let i = 1; i < amps.length; i++) {
        const a = amps[i];
        if (a > amps[peak] || (peak === 0 && a > 0)) peak = i;
        weight += a;
        weighted += i * a;
        if (wantRolloff || wantEntropy) energy += a * a;
        if (wantFlatness) logSum += Math.log(a + 1e-12);
      }
      const centroid = weight ? (weighted * spec.binHz) / weight : 0;
      result.peakHz = peak * spec.binHz;
      result.centroid = centroid;
      if (wantBandwidth) {
        let spread = 0;
        if (weight) {
          for (let i = 1; i < amps.length; i++) {
            const df = i * spec.binHz - centroid;
            spread += amps[i] * df * df;
          }
        }
        result.bandwidth = weight ? Math.sqrt(spread / weight) : 0;
      }
      if (wantRolloff) {
        let rolloff = 0;
        if (energy) {
          const target = 0.85 * energy;
          let acc = 0;
          for (let i = 1; i < amps.length; i++) {
            acc += amps[i] * amps[i];
            if (acc >= target) {
              rolloff = i * spec.binHz;
              break;
            }
          }
        }
        result.rolloff = rolloff;
      }
      if (wantFlatness) {
        result.flatness = weight && m > 0 ? Math.min(1, Math.exp(logSum / m) / (weight / m)) : 0;
      }
      if (wantEntropy) {
        let h = 0;
        if (energy && m > 1) {
          for (let i = 1; i < amps.length; i++) {
            const p = (amps[i] * amps[i]) / energy;
            if (p > 0) h -= p * Math.log(p);
          }
          h /= Math.log(m);
        }
        result.entropy = Math.max(0, Math.min(1, h));
      }
    }
    for (const name of recipe.features) {
      if (name === 'raw')
        for (let j = 0; j < 32; j++) out.push(v[Math.round((j * (v.length - 1)) / 31)]);
      else out.push(result[name]);
    }
  }
  return out;
}
