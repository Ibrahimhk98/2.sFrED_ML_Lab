import { newSession } from '../session.js';
import { groupOf } from './catalog.js';

export const liveTopic = 'pal-behavior-lab-v1';
export function createPublisher(getConnection) {
  if (typeof BroadcastChannel === 'undefined') return { wants: () => false, send() {} };
  const bus = new BroadcastChannel(liveTopic),
    source = crypto.randomUUID();
  const expires = {};
  bus.onmessage = ({ data }) => {
    const connection = getConnection();
    if (data.type === 'discover' && connection) bus.postMessage({ type: 'source', source, connection });
    if (data.type === 'subscribe' && data.source === source && connection)
      for (const group of data.groups) expires[group] = Date.now() + 3500;
  };
  return {
    wants: (group) => expires[group] > Date.now() && !!getConnection(),
    send(group, rows) {
      const connection = getConnection();
      if (rows.length && connection)
        bus.postMessage({ type: 'samples', source, connection, group, rows });
    }
  };
}

// Keep only the chosen sensor groups and use their common time range. A change
// of kit or transport starts a new buffer even if two clocks happen to agree.
export class LiveWindow {
  constructor(recipe) {
    this.recipe = recipe;
    this.groups = [...new Set(recipe.channels.map(groupOf))];
    this.reset();
  }
  reset() {
    this.session = newSession();
    this.latest = {};
    this.lastEnd = -Infinity;
    this.lastPrune = -Infinity;
  }
  append({ group, rows, connection }) {
    if (!this.groups.includes(group) || !rows.length) return null;
    const epoch = connection.epoch + '/' + connection.id;
    if (this.epoch !== epoch || rows.at(-1).time_ms < (this.latest[group] ?? -Infinity) - 2000)
      this.reset();
    this.epoch = epoch;
    for (const row of rows) this.session[group].push(row);
    const last = rows.at(-1);
    this.latest[group] = last.time_ms + (group === 'audio' ? (last.pcm.length * 1000) / last.rate : 0);
    const newest = Math.max(...Object.values(this.latest)),
      width = this.recipe.seconds * 1000;
    if (newest - this.lastPrune >= 500) {
      const cutoff = newest - width - 3000;
      for (const key of this.groups)
        this.session[key] = this.session[key].filter((r) => r.time_ms >= cutoff);
      this.lastPrune = newest;
    }
    const end = Math.min(...this.groups.map((key) => this.latest[key] ?? -Infinity));
    if (
      !Number.isFinite(end) ||
      newest - end > 2500 ||
      end - this.lastEnd < Math.max(100, width * (1 - this.recipe.overlap / 100))
    )
      return null;
    const start = end - width;
    if (this.groups.some((k) => !this.session[k].length || this.session[k][0].time_ms > start + 1))
      return null;
    this.lastEnd = end;
    return { start, end, session: this.session };
  }
}
