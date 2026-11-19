import { newSession } from '../session.js';

// Two repeatable bench conditions, three independent trials apiece.
export function exampleTrial(index) {
  const spinning = index % 2 === 1,
    run = Math.floor(index / 2) + 1,
    hz = spinning ? 9 + run * 0.3 : 2 + run * 0.1;
  const s = newSession(),
    seconds = 24,
    start = 1700000000000 + index * 60000;
  let state = 17 + index;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
  const signal = (t) => Math.sin(2 * Math.PI * hz * t + run);
  for (let i = 0; i < 104 * seconds; i++) {
    const t = i / 104,
      v = (spinning ? 1.8 : 0.12) * signal(t) + noise() * 0.06;
    s.imu.push({
      time_ms: start + t * 1000,
      ax: v,
      ay: 0.4 * v + noise() * 0.1,
      az: 9.8 + 0.3 * v,
      gx: 0.2 * v,
      gy: 0.1 * v,
      gz: 0.03 * v
    });
  }
  for (let i = 0; i < seconds; i++)
    s.environment.push({
      time_ms: start + i * 1000,
      temperature_c: 23 + run * 0.3 + i * 0.005,
      humidity_pct: 42 + noise(),
      pressure_hpa: 1012 + noise(),
      gas_ohms: 84000 + 30 * noise(),
      iaq: 38,
      voc_ppm: 0.2,
      eco2_ppm: 480,
      battery_v: 4.1,
      battery_pct: 93
    });
  for (let i = 0; i < seconds * 10; i++) {
    const rate = 8000,
      pcm = Int16Array.from({ length: 800 }, (_, j) =>
        Math.round(
          1800 *
            (spinning ? 1 : 0.1) *
            Math.sin(2 * Math.PI * (spinning ? 330 : 85) * (i * 0.1 + j / rate)) +
            100 * noise()
        )
      );
    s.audio.push({ time_ms: start + i * 100, rate, sequence: i, segment: 0, stream_id: 1, pcm });
  }
  const label = spinning ? 'Rotating' : 'Resting';
  return {
    session: s,
    name: `${label.toLowerCase()}-trial-${run} · example`,
    label,
    partition: ['train', 'validation', 'test'][run - 1]
  };
}
