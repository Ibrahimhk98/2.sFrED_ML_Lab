import {
  groups,
  ports,
  portNames,
  toneOf,
  createBlock,
  findNode,
  connect,
  removeBlock,
  starterGraph,
  emptyGraph,
  title,
  blockName
} from './graph.js';

const $ = (id) => document.getElementById(id);
const width = 182,
  height = 92,
  grid = 8,
  socketY = 72;
const snap = (value) => Math.round(value / grid) * grid;
const symbols = {
  source: 'M3 14v4h14v-4 M10 2v11 m-4-4 4 4 4-4',
  scope: 'M1 11h4l2-7 4 13 3-10 2 4h3',
  windows: 'M2 4h16v12H2z M7 4v12 m6-12v12',
  filters: 'M2 5h16 M5 10h10 M8 15h4',
  features: 'M3 16v-5 M8 16V4 M13 16V8 M18 16V2',
  scale: 'M3 6h14 M3 14h14 M8 3v6 M13 11v6',
  plots: 'M2 3v14h16 M5 12h1 M8 8h1 M10 11h1 M13 6h1 M16 4h1',
  knn: 'M4 4h2v2H4z M12 4h2v2h-2z M9 10h2v2H9z M3 14h2v2H3z M15 14h2v2h-2z',
  ridge: 'M2 3v14h16 M5 13l11-8',
  tree: 'M9 2h3v4H9z M10.5 6v4 H5v4 M11 10h5v4 M3 14h4v4H3z M14 14h4v4h-4z',
  forest: 'M6 2 1 11h3l-3 4h10l-3-4h3z M6 15v3 M14 4l5 10h-4v4',
  kernel: 'M1 15c5 0 4-11 9-11s4 11 9 11',
  scores: 'M3 16v-5h3v5z M9 16V7h3v9z M15 16V3h3v13z',
  live: 'M2 10h4l2-5 4 10 2-5h4'
};
const icon = (type) =>
  `<span class="block-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="${symbols[type]}"/></svg></span>`;
const shortInput = (type) =>
  type === 'scores'
    ? 'Models'
    : type === 'live'
      ? 'Model'
      : ports[type].input.includes('features')
        ? 'Features'
        : portNames[ports[type].input[0]];
const snapshot = (g) => ({
  nodes: g.nodes.map((n) => ({ ...n })),
  edges: g.edges.map((e) => ({ ...e }))
});
function path(a, b) {
  if ((b.x - a.x) * a.dir < 0) {
    // Carry a returning wire through the gap between rows, or below a shared row.
    const lane =
      Math.abs(a.y - b.y) >= height + 32
        ? (a.y + b.y + height) / 2 - socketY
        : Math.max(a.y, b.y) + height - socketY + 24;
    const exit = a.x + a.dir * 36,
      entry = b.x + b.dir * 36;
    return `M${a.x},${a.y} C${exit},${a.y} ${exit},${lane} ${a.x},${lane} L${b.x},${lane} C${entry},${lane} ${entry},${b.y} ${b.x},${b.y}`;
  }
  const reach = Math.max(44, Math.min(145, Math.abs(a.x - b.x) * 0.48 + Math.abs(a.y - b.y) * 0.19));
  return `M${a.x},${a.y} C${a.x + a.dir * reach},${a.y} ${b.x + b.dir * reach},${b.y} ${b.x},${b.y}`;
}

export function graphEditor(g, { onSelect, onChange, describe, status, isBusy }) {
  const view = $('viewport'),
    world = $('world'),
    wires = $('wireGroup');
  const back = [],
    forward = [];
  let selected = g.nodes[0]?.id,
    wire = null,
    pending = null,
    gesture = null,
    pointer = null;
  let zoom = 1,
    pan = { x: 0, y: 0 },
    fitMode = true;
  const screen = (e) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (p) => ({ x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom });
  const portPoint = (id, side) => {
    const n = findNode(g, id),
      right = side === 'out';
    return { x: n.x + (right ? width : 0), y: n.y + socketY, dir: right ? 1 : -1 };
  };
  function save(previous = snapshot(g)) {
    back.push(previous);
    if (back.length > 80) back.shift();
    forward.length = 0;
  }
  function select(id, focus = false) {
    selected = id;
    wire = null;
    world.querySelectorAll('.graph-node').forEach((el) => {
      el.classList.toggle('selected', el.dataset.id === id);
      el.querySelector('.block-title').setAttribute('aria-pressed', String(el.dataset.id === id));
    });
    drawWires();
    onSelect(id, null, focus);
  }
  function selectWire(edge) {
    select(null);
    wire = edge;
    drawWires();
    onSelect(null, edge);
  }
  function refreshLibrary() {
    const query = $('searchBlocks').value.trim().toLowerCase();
    $('libraryItems').innerHTML =
      Object.entries(groups)
        .map(([group, types]) => {
          const items = types.filter((k) => (title(k) + ' ' + group).toLowerCase().includes(query));
          return items.length
            ? `<section class="library-group"><h4>${group}</h4>${items
                .map(
                  (k) =>
                    `<button class="library-item" draggable="true" data-palette="${k}" data-tone="${toneOf(k)}" title="Drag or click to add ${title(k)}">${icon(k)}${title(k)}</button>`
                )
                .join('')}</section>`
            : '';
        })
        .join('') || '<p class="hint">No matching blocks.</p>';
  }
  function renderPorts(n) {
    const def = ports[n.type];
    return ['in', 'out']
      .map((side) => {
        const input = side === 'in';
        if (input ? !def.input.length : !def.output) return '';
        const label = input ? shortInput(n.type) : portNames[def.output];
        const accepted = input ? def.input.map((k) => portNames[k]).join(' or ') : label;
        const linked = g.edges.some((e) => (input ? e.to : e.from) === n.id);
        return `<button class="graph-port ${linked ? 'linked' : ''}" data-port="${side}" aria-label="${title(n.type)} ${input ? 'input' : 'output'} · ${accepted}" title="${input ? 'Accepts' : 'Supplies'} ${accepted}">${label}</button>`;
      })
      .join('');
  }
  function render() {
    world.replaceChildren();
    for (const n of g.nodes) {
      const el = document.createElement('div');
      el.className = 'graph-node' + (n.id === selected ? ' selected' : '');
      el.dataset.id = n.id;
      el.dataset.type = n.type;
      el.dataset.tone = toneOf(n.type);
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.innerHTML = `<div class="node-head">${icon(n.type)}<button class="block-title" aria-pressed="${n.id === selected}"></button></div><p class="node-detail"></p><div class="port-row">${renderPorts(n)}</div>`;
      el.querySelector('.block-title').textContent = blockName(g, n);
      el.querySelector('.node-detail').textContent = describe(n);
      world.append(el);
    }
    $('emptyCanvas').hidden = !!g.nodes.length;
    $('layoutAction').textContent = g.nodes.length ? 'Blank canvas' : 'Starter pipeline';
    $('graphCount').textContent = `${g.nodes.length} blocks · ${g.edges.length} wires`;
    $('undo').disabled = !back.length || isBusy();
    $('redo').disabled = !forward.length || isBusy();
    $('layoutAction').disabled = isBusy();
    $('libraryItems').inert = isBusy();
    drawWires();
    highlightPorts();
  }
  function drawWires() {
    wires.innerHTML = g.edges
      .map((e) => {
        const n = findNode(g, e.from),
          d = path(portPoint(e.from, 'out'), portPoint(e.to, 'in'));
        return `<g data-tone="${toneOf(n.type)}"><path class="wire ${wire?.from === e.from && wire?.to === e.to ? 'wire-selected' : ''}" d="${d}"/><path class="wire-hit" d="${d}" data-from="${e.from}" data-to="${e.to}"/></g>`;
      })
      .join('');
    if (pending && pointer && findNode(g, pending.id)) {
      const a = portPoint(pending.id, pending.side);
      wires.insertAdjacentHTML(
        'beforeend',
        `<path class="temporary-wire" d="${path(a, { ...pointer, dir: -a.dir })}"/>`
      );
    }
  }
  function transform() {
    world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
    wires.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`);
    view.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    view.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
    $('zoomLevel').textContent = Math.round(zoom * 100) + '%';
  }
  function fit(auto = false) {
    fitMode = true;
    if (!g.nodes.length) {
      zoom = 1;
      pan = { x: 0, y: 0 };
      transform();
      return;
    }
    const xs = g.nodes.map((n) => n.x),
      ys = g.nodes.map((n) => n.y);
    const left = Math.min(...xs) - 18,
      top = Math.min(...ys) - 4;
    const w = Math.max(...xs) + width + 55 - left,
      h = Math.max(...ys) + height + 12 - top;
    zoom = Math.max(0.22, Math.min(1.18, (view.clientWidth - 36) / w, (view.clientHeight - 68) / h));
    pan = {
      x: (view.clientWidth - w * zoom) / 2 - left * zoom,
      y: (view.clientHeight - 38 - h * zoom) / 2 - top * zoom
    };
    if (auto === true && view.clientWidth < 510 && zoom < 0.8) {
      const first = findNode(g, selected) || g.nodes[0];
      zoom = 0.85;
      pan = { x: 28 - first.x * zoom, y: view.clientHeight * 0.42 - first.y * zoom };
    }
    transform();
  }
  function setZoom(next, center = { x: view.clientWidth / 2, y: view.clientHeight / 2 }) {
    const at = toWorld(center);
    fitMode = false;
    zoom = Math.max(0.2, Math.min(2.4, next));
    pan = { x: center.x - at.x * zoom, y: center.y - at.y * zoom };
    transform();
  }
  function highlightPorts() {
    const node = pending && findNode(g, pending.id);
    world.querySelectorAll('.graph-port').forEach((el) => {
      const n = findNode(g, el.closest('.graph-node').dataset.id),
        side = el.dataset.port;
      const match =
        node &&
        side !== pending.side &&
        (side === 'in'
          ? ports[n.type].input.includes(ports[node.type].output)
          : ports[node.type].input.includes(ports[n.type].output));
      el.classList.toggle('match', !!match);
      el.classList.toggle('pending', !!node && n.id === node.id && side === pending.side);
    });
  }
  function cancelWire() {
    pending = null;
    pointer = null;
    highlightPorts();
    drawWires();
  }
  function edited(id, structural = true) {
    pending = null;
    pointer = null;
    wire = null;
    selected = id;
    if (structural) onChange();
    render();
    onSelect(id, null);
  }
  function add(type, point) {
    if (isBusy() || !Object.hasOwn(ports, type)) return;
    const source = type === 'source' && g.nodes.find((n) => n.type === 'source');
    if (source) {
      select(source.id, true);
      status('Import additional recordings in the existing dataset block.');
      return;
    }
    const pos = point || toWorld({ x: view.clientWidth * 0.48, y: view.clientHeight * 0.48 });
    let x = snap(pos.x - width / 2),
      y = snap(pos.y - height / 2);
    if (!point)
      while (g.nodes.some((n) => Math.abs(n.x - x) < 16 && Math.abs(n.y - y) < 16)) {
        x += 24;
        y += 24;
      }
    const n = createBlock(type, x, y);
    save();
    g.nodes.push(n);
    fitMode = false;
    edited(n.id);
    status(`${blockName(g, n)} added. Connect its ports on the grid.`);
  }
  function disconnect(from, to) {
    if (isBusy()) return;
    save();
    g.edges = g.edges.filter((e) => e.from !== from || e.to !== to);
    edited(selected);
    status('Wire disconnected.');
  }
  function remove() {
    if (isBusy()) return;
    if (wire) {
      disconnect(wire.from, wire.to);
      return;
    }
    if (!selected) return;
    save();
    removeBlock(g, selected);
    edited(null);
    status('Block removed. Undo restores its connections.');
  }
  function restore(stack, other) {
    if (isBusy() || !stack.length) return;
    other.push(snapshot(g));
    const restored = stack.pop();
    Object.assign(g, restored);
    edited(findNode(g, selected) ? selected : g.nodes[0]?.id);
    fit();
  }
  function layout(starter) {
    if (isBusy()) return;
    save();
    Object.assign(g, starter ? starterGraph() : emptyGraph());
    edited(g.nodes[0]?.id);
    fit();
    status(
      starter
        ? 'Starter pipeline loaded.'
        : 'Canvas cleared. Your imported recordings are available when you add Import recordings.'
    );
  }
  function finishWire(a, b) {
    cancelWire();
    if (!a || !b || a.side === b.side) {
      status('Connect an output port to an input port.', true);
      return;
    }
    const from = a.side === 'out' ? a.id : b.id,
      to = a.side === 'in' ? a.id : b.id,
      prev = snapshot(g);
    try {
      if (!connect(g, from, to)) return;
      save(prev);
      edited(to);
      status(`${blockName(g, findNode(g, from))} → ${blockName(g, findNode(g, to))} connected.`);
    } catch (e) {
      status(e.message, true);
    }
  }
  function portAt(el) {
    const p = el?.closest('.graph-port');
    return p ? { side: p.dataset.port, id: p.closest('.graph-node').dataset.id } : null;
  }
  function pickPort(p) {
    if (pending) {
      if (pending.id === p.id && pending.side === p.side) {
        cancelWire();
        return;
      }
      finishWire(pending, p);
      return;
    }
    pending = p;
    pointer = portPoint(p.id, p.side);
    highlightPorts();
    drawWires();
    status('Choose a highlighted port to complete the wire. Escape cancels.');
  }
  $('searchBlocks').oninput = refreshLibrary;
  refreshLibrary();
  $('libraryItems').addEventListener('dragstart', (e) => {
    const k = e.target.closest('[data-palette]')?.dataset.palette;
    if (!k || isBusy()) return e.preventDefault();
    e.dataTransfer.setData('application/x-pal-block', k);
    e.dataTransfer.effectAllowed = 'copy';
  });
  $('libraryItems').onclick = (e) => {
    const k = e.target.closest('[data-palette]')?.dataset.palette;
    if (k) add(k);
  };
  view.ondragover = (e) => {
    if (e.dataTransfer.types.includes('application/x-pal-block')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      view.classList.add('drag-over');
    }
  };
  view.ondragleave = (e) => {
    if (!view.contains(e.relatedTarget)) view.classList.remove('drag-over');
  };
  view.ondrop = (e) => {
    const k = e.dataTransfer.getData('application/x-pal-block');
    if (k) {
      e.preventDefault();
      view.classList.remove('drag-over');
      add(k, toWorld(screen(e)));
    }
  };
  view.onpointerdown = (e) => {
    if (isBusy() || e.button !== 0 || gesture || e.target.closest('.canvas-tools,.canvas-empty')) return;
    const port = portAt(e.target),
      node = e.target.closest('.graph-node'),
      edge = e.target.closest('.wire-hit');
    if (edge && !port) {
      view.focus({ preventScroll: true });
      cancelWire();
      selectWire({ from: edge.dataset.from, to: edge.dataset.to });
      return;
    }
    const at = screen(e);
    if (port) {
      gesture = { kind: 'wire', port, previous: pending, at };
      if (!pending) pending = port;
      pointer = toWorld(at);
      highlightPorts();
      drawWires();
    } else if (node) {
      cancelWire();
      select(node.dataset.id);
      const n = findNode(g, selected);
      gesture = { kind: 'move', n, at, original: { x: n.x, y: n.y }, before: snapshot(g) };
    } else {
      cancelWire();
      gesture = { kind: 'pan', at, original: { ...pan } };
    }
    gesture.pointerId = e.pointerId;
    view.setPointerCapture(e.pointerId);
    view.focus({ preventScroll: true });
    e.preventDefault();
  };
  view.onpointermove = (e) => {
    const at = screen(e);
    if (pending) {
      pointer = toWorld(at);
      drawWires();
    }
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    const dx = at.x - gesture.at.x,
      dy = at.y - gesture.at.y;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !gesture.moved) return;
    gesture.moved = true;
    fitMode = false;
    if (gesture.kind === 'pan') {
      pan = { x: gesture.original.x + dx, y: gesture.original.y + dy };
      transform();
    }
    if (gesture.kind === 'move') {
      const n = gesture.n;
      n.x = snap(gesture.original.x + dx / zoom);
      n.y = snap(gesture.original.y + dy / zoom);
      const el = world.querySelector(`[data-id="${n.id}"]`);
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      drawWires();
    }
  };
  const finish = (e, cancelled) => {
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    const last = gesture;
    gesture = null;
    if (view.hasPointerCapture(e.pointerId)) view.releasePointerCapture(e.pointerId);
    if (cancelled) {
      if (last.n) Object.assign(last.n, last.original);
      cancelWire();
      render();
      return;
    }
    if (last.kind === 'move' && last.moved) {
      save(last.before);
      render();
    }
    if (last.kind === 'pan' && !last.moved) select(null);
    if (last.kind === 'wire') {
      const end = portAt(document.elementFromPoint(e.clientX, e.clientY));
      if (last.moved) {
        if (end) finishWire(last.previous || last.port, end);
        else cancelWire();
      } else {
        pending = last.previous;
        pickPort(last.port);
      }
    }
  };
  view.onpointerup = (e) => finish(e, false);
  view.onpointercancel = (e) => finish(e, true);
  // Pointer capture retargets native double clicks. Inspect the coordinate under the cursor.
  view.ondblclick = (e) => {
    const n = document.elementFromPoint(e.clientX, e.clientY)?.closest('.graph-node');
    if (n && !isBusy() && !portAt(document.elementFromPoint(e.clientX, e.clientY)))
      select(n.dataset.id, true);
  };
  world.onclick = (e) => {
    if (e.detail || isBusy()) return;
    const port = portAt(e.target);
    if (port) {
      pickPort(port);
      return;
    }
    const node = e.target.closest('.graph-node');
    if (node) select(node.dataset.id, true);
  };
  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setZoom(zoom * Math.exp(-e.deltaY * 0.01), screen(e));
      else {
        fitMode = false;
        pan.x -= e.deltaX;
        pan.y -= e.deltaY;
        transform();
      }
    },
    { passive: false }
  );
  view.onkeydown = (e) => {
    if (isBusy()) return;
    if (e.key === 'Escape') {
      cancelWire();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? restore(forward, back) : restore(back, forward);
    }
    const n = findNode(g, selected),
      delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (delta && n) {
      e.preventDefault();
      save();
      n.x += grid * delta[0];
      n.y += grid * delta[1];
      render();
      view.focus();
    }
  };
  $('zoomOut').onclick = () => setZoom(zoom / 1.2);
  $('zoomIn').onclick = () => setZoom(zoom * 1.2);
  $('fitGraph').onclick = fit;
  $('undo').onclick = () => restore(back, forward);
  $('redo').onclick = () => restore(forward, back);
  $('layoutAction').onclick = () => layout(!g.nodes.length);
  $('starter').onclick = () => layout(true);
  $('removeSelection').onclick = remove;
  new ResizeObserver(() => {
    if (fitMode) fit(true);
  }).observe(view);
  render();
  fit(true);
  return { render, select, disconnect, fit };
}
