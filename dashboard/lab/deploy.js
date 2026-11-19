import { models, channels } from './catalog.js';
import { liveTopic } from './live.js';
import { download } from '../files.js';

export function deployment(call, send, esc, status) {
  const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel(liveTopic) : null;
  const sources = new Map();
  let loaded,
    kind = '',
    source = '',
    listening,
    generation = 0,
    prediction = 'Waiting for a full window',
    lastPrediction = 0;
  const el = (id) => document.getElementById(id);
  function stop() {
    generation++;
    listening = null;
    send('stop');
    prediction = 'Stopped';
    lastPrediction = 0;
    refresh();
  }
  function refresh() {
    if (!el('liveSource')) return;
    const select = el('liveSource');
    if (!sources.has(source) && !listening) source = sources.keys().next().value || '';
    const options = [...sources]
      .map(
        ([id, v]) =>
          `<option value="${esc(id)}" ${id === source ? 'selected' : ''}>${esc(v.connection.name)} · ${esc(v.connection.transport)} · ${esc(id.slice(0, 5))}</option>`
      )
      .join('');
    const html = options || '<option value="">Waiting for connected kit</option>';
    if (select.dataset.options !== html) {
      select.innerHTML = html;
      select.dataset.options = html;
    }
    select.disabled = !!listening;
    el('chosenModel').disabled = !!listening;
    el('startLive').disabled = !kind || !source || !bus || !!listening;
    el('stopLive').disabled = !listening;
    el('saveModel').disabled = !kind;
    el('liveValue').textContent = prediction;
  }
  if (bus)
    bus.onmessage = ({ data }) => {
      if (data.type === 'source') {
        sources.set(data.source, { ...data, seen: Date.now() });
        refresh();
      }
      if (data.type === 'samples' && listening && source === data.source) send('samples', data);
    };
  function heartbeat() {
    bus?.postMessage({ type: 'discover' });
    for (const [id, v] of sources)
      if (Date.now() - v.seen > 4500) {
        sources.delete(id);
        if (listening && source === id) {
          stop();
          prediction = 'Kit disconnected';
        }
      }
    if (listening) {
      bus.postMessage({ type: 'subscribe', source, groups: listening.groups });
      if (lastPrediction && Date.now() - lastPrediction > Math.max(3500, 1500 + listening.hop * 1000))
        prediction = 'Waiting for fresh samples';
    }
    refresh();
  }
  setInterval(heartbeat, 1000);
  function mount(panel, run) {
    const choices = (run?.candidates || []).map((c) => [
      c.id,
      c.name + (c.id === run.best ? ' · validation winner' : '')
    ]);
    if (loaded) choices.push(['loaded', 'Saved · ' + models[loaded.name].name]);
    if (!choices.some(([k]) => k === kind)) kind = run?.best || choices[0]?.[0] || '';
    panel.innerHTML = `<div class="rubric"><label>Trained model<select id="chosenModel">${choices.map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${esc(v)}</option>`).join('') || '<option>Train or open a model</option>'}</select></label>
      <button id="saveModel">Save model file</button><button id="loadButton">Open saved model</button><input type="file" id="modelFile" accept=".json" hidden></div>
      <p class="hint" id="recipeInfo"></p><h3>Live prediction</h3><p class="hint">Open <a href="kit.html" target="_blank" rel="noopener">Live kit</a>, connect your kit, and leave that tab open while predicting.</p>
      <div class="rubric"><label>Connected kit<select id="liveSource"></select></label><button id="startLive" class="btn-primary">Start prediction</button><button id="stopLive">Stop</button></div>
      <div class="result">Detected behavior or value<output id="liveValue" aria-live="polite"></output></div>`;
    const showRecipe = () => {
      const r = kind === 'loaded' ? loaded.recipe : run?.candidates.find((c) => c.id === kind)?.recipe;
      el('recipeInfo').textContent = r
        ? `${r.task} · ${r.seconds} s windows · ${r.channels.map((k) => channels[k][0]).join(', ')} · ${r.features.length} feature selections`
        : 'A model file can be opened in a fresh lab tab.';
    };
    showRecipe();
    el('chosenModel').onchange = (e) => {
      stop();
      kind = e.target.value;
      showRecipe();
      refresh();
    };
    el('liveSource').onchange = (e) => {
      source = e.target.value;
      refresh();
    };
    el('loadButton').onclick = () => el('modelFile').click();
    el('modelFile').onchange = async (e) => {
      const input = e.target;
      const file = input.files[0];
      if (!file) return;
      try {
        if (file.size > 128 * 1048576) throw new Error('Model exceeds the 128 MiB import limit.');
        const info = await call('load', { file });
        stop();
        loaded = info;
        kind = 'loaded';
        prediction = 'Ready';
        if (input.isConnected) mount(panel, run);
        status('Saved model ready.');
      } catch (error) {
        status(error.message, true);
      } finally {
        input.value = '';
      }
    };
    el('saveModel').onclick = async () => {
      try {
        download(
          await call('export', { kind }),
          'pal-' +
            (kind === 'loaded' ? loaded.name : run.candidates.find((c) => c.id === kind).kind) +
            '-model.json',
          'application/json'
        );
        status('Model file exported.');
      } catch (error) {
        status(error.message, true);
      }
    };
    el('startLive').onclick = async () => {
      const token = ++generation;
      try {
        const info = await call('start', { kind });
        if (token !== generation) return;
        listening = info;
        prediction = 'Collecting ' + info.seconds + ' s of samples…';
        lastPrediction = 0;
        heartbeat();
      } catch (error) {
        status(error.message, true);
      }
    };
    el('stopLive').onclick = stop;
    refresh();
    heartbeat();
  }
  return {
    mount,
    stop,
    resetSelection() {
      kind = '';
    },
    update(value) {
      if (!listening) return;
      prediction =
        value === null
          ? 'Incomplete sensor window'
          : typeof value === 'number'
            ? Number(value.toPrecision(6)).toString()
            : value;
      lastPrediction = Date.now();
      refresh();
    }
  };
}
