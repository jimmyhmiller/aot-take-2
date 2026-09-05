const EXAMPLES = {
  object: `function main() {
  let node = { left: 1, right: 2, item: 3 };
  return node.item;
}`,
  branch: `function main(condition) {
  return condition ? 20 : 30;
}`,
  arithmetic: `function main() {
  return 2 + 3 * 4;
}`,
  guard: `function main(value) {
  return value ? value + 1 : 0;
}`
};

// Simple's graph vocabulary, adjusted only for contrast on the dark browser surface.
const nodeColors = {
  control: '#f4cf4f', integer: '#91c9f7', float: '#65d8df', memory: '#477ed1',
  pointer: '#67bd73', function: '#eea64d', rpc: '#ead9bd', nil: '#b7bec8',
  dynamic: '#c99bea', shape: '#79c58d', string: '#72c7b6', new: '#86ce79', unknown: '#ef7777'
};
const edgeColors = { control: '#ef5b5b', memory: '#568ee8', gc: '#f06f6f', value: '#aab6c8', projection: '#aab6c8' };
const PHASES = [
  ['Parse', 'source → ideal graph'], ['Iter', 'pessimistic peepholes'],
  ['Opto', 'interprocedural optimization'], ['Typecheck', 'final semantic validation'],
  ['Looptree', 'loop discovery'], ['Serialize', 'cross-unit boundary and barriers'],
  ['Unlink', 'detach calls for lowering'], ['Select', 'ideal → ARM64 machine graph'],
  ['Schedule', 'global code motion'], ['LocalSched', 'block-local instruction order'],
  ['Regalloc', 'register allocation'], ['Encoding', 'layout and relocations'],
  ['Export', 'object-file boundary']
];

export class WasmHost {
  constructor(baseUrl = new URL('.', import.meta.url)) {
    this.baseUrl = baseUrl;
    this.instance = null;
    this.memory = null;
    this.heapTop = 0;
    this.freeBins = new Map();
    this.files = new Map();
    this.fds = new Map();
    this.nextFd = 3;
    this.result = null;
    this.output = '';
    this.wasmBytes = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  get u8() { return new Uint8Array(this.memory.buffer); }
  get dv() { return new DataView(this.memory.buffer); }
  cstr(ptr) { let end = ptr; const bytes = this.u8; while (bytes[end]) end++; return this.decoder.decode(bytes.subarray(ptr, end)); }
  text(ptr, len) { return this.decoder.decode(this.u8.subarray(ptr, ptr + len)); }
  grow(end) { const have = this.memory.buffer.byteLength; if (end > have) this.memory.grow(Math.ceil((end - have) / 65536)); }

  malloc(size) {
    size = Math.max(16, (Number(size) + 15) & ~15);
    const bin = this.freeBins.get(size);
    if (bin?.length) {
      const ptr = bin.pop();
      this.dv.setBigUint64(ptr - 8, BigInt(size), true);
      return ptr;
    }
    const ptr = ((this.heapTop + 15) & ~15) + 16;
    this.heapTop = ptr + size;
    this.grow(this.heapTop);
    this.dv.setBigUint64(ptr - 8, BigInt(size), true);
    return ptr;
  }

  free(ptr) {
    ptr = Number(ptr);
    if (ptr < 16 || ptr >= this.heapTop) return;
    const size = Number(this.dv.getBigUint64(ptr - 8, true));
    if (!size || ptr + size > this.heapTop) return;
    this.dv.setBigUint64(ptr - 8, 0n, true);
    let bin = this.freeBins.get(size);
    if (!bin) { bin = []; this.freeBins.set(size, bin); }
    bin.push(ptr);
  }

  realloc(ptr, size) {
    ptr = Number(ptr); size = Number(size);
    if (!ptr) return this.malloc(size);
    if (!size) { this.free(ptr); return 0; }
    const old = Number(this.dv.getBigUint64(ptr - 8, true));
    if (old >= size) return ptr;
    const next = this.malloc(size);
    this.u8.copyWithin(next, ptr, ptr + old);
    this.free(ptr);
    return next;
  }

  normalize(path) {
    const parts = [];
    for (const part of path.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  }

  imports() {
    return { env: {
      malloc: (n) => this.malloc(n),
      realloc: (p, n) => this.realloc(p, n),
      free: (p) => this.free(p),
      posix_memalign: (out, alignment, size) => {
        alignment = Number(alignment); size = Number(size);
        if (alignment < 4 || (alignment & (alignment - 1)) !== 0) return 22;
        const raw = this.malloc(size + alignment + 16);
        const aligned = Math.ceil((raw + 16) / alignment) * alignment;
        this.dv.setBigUint64(aligned - 8, BigInt(Math.max(16, (size + 15) & ~15)), true);
        this.dv.setUint32(Number(out), aligned, true);
        return 0;
      },
      memcmp: (a, b, n) => {
        const bytes = this.u8;
        for (let i = 0; i < Number(n); i++) if (bytes[Number(a) + i] !== bytes[Number(b) + i]) return bytes[Number(a) + i] - bytes[Number(b) + i];
        return 0;
      },
      strlen: (p) => { let end = Number(p); while (this.u8[end]) end++; return end - Number(p); },
      strtod: (p, endp) => {
        const start = Number(p); const text = this.cstr(start);
        const match = text.match(/^\s*[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
        const value = match ? Number(match[0]) : 0;
        if (Number(endp)) this.dv.setUint32(Number(endp), match ? start + this.encoder.encode(match[0]).length : start, true);
        return value;
      },
      __multi3: (out, alo, ahi, blo, bhi) => {
        const a = BigInt.asUintN(128, BigInt.asUintN(64, alo) | (BigInt.asUintN(64, ahi) << 64n));
        const b = BigInt.asUintN(128, BigInt.asUintN(64, blo) | (BigInt.asUintN(64, bhi) << 64n));
        const value = BigInt.asUintN(128, a * b);
        this.dv.setBigUint64(Number(out), BigInt.asUintN(64, value), true);
        this.dv.setBigUint64(Number(out) + 8, BigInt.asUintN(64, value >> 64n), true);
      },
      open: (pathPtr) => {
        const path = this.normalize(this.cstr(Number(pathPtr)));
        const data = this.files.get(path);
        if (!data) return -1;
        const fd = this.nextFd++;
        this.fds.set(fd, { data, pos: 0 });
        return fd;
      },
      read: (fd, ptr, count) => {
        const file = this.fds.get(Number(fd));
        if (!file) return -1;
        const size = Math.min(Number(count), file.data.length - file.pos);
        this.u8.set(file.data.subarray(file.pos, file.pos + size), Number(ptr));
        file.pos += size;
        return size;
      },
      close: (fd) => (this.fds.delete(Number(fd)), 0),
      write: (fd, ptr, len) => { this.output += this.text(Number(ptr), Number(len)); return Number(len); },
      dlsym: () => 0,
      graph_result: (ptr, len) => { this.result = JSON.parse(this.text(Number(ptr), Number(len))); return 0; },
      abort: () => { throw new Error(this.output || 'Coil graph compiler aborted'); },
      _exit: (code) => { throw new Error(`Coil graph compiler exited with ${code}: ${this.output}`); }
    }};
  }

  async load() {
    const indexUrl = new URL('../jsl/compiler/index', this.baseUrl);
    const indexResponse = await fetch(indexUrl);
    if (!indexResponse.ok) throw new Error(`Unable to load ${indexUrl.pathname}: ${indexResponse.status}`);
    const indexText = await indexResponse.text();
    this.files.set('jsl/compiler/index', this.encoder.encode(indexText));
    const paths = indexText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    await Promise.all(paths.map(async (path) => {
      const response = await fetch(new URL(`../${path}`, this.baseUrl));
      if (!response.ok) throw new Error(`Unable to load ${path}: ${response.status}`);
      this.files.set(path, new Uint8Array(await response.arrayBuffer()));
    }));
    const wasmUrl = new URL('aot-graph.wasm', this.baseUrl);
    const wasmResponse = await fetch(wasmUrl);
    if (!wasmResponse.ok) throw new Error(`Unable to load ${wasmUrl.pathname}: ${wasmResponse.status}`);
    this.wasmBytes = await wasmResponse.arrayBuffer();
    await this.resetRuntime();
  }

  async resetRuntime() {
    this.heapTop = 0;
    this.freeBins.clear();
    this.fds.clear();
    this.nextFd = 3;
    const { instance } = await WebAssembly.instantiate(this.wasmBytes, this.imports());
    this.instance = instance;
    this.memory = instance.exports.memory;
    this.heapTop = Number(instance.exports.__heap_base.value);
  }

  async compile(source, phase) {
    // A compilation owns all Coil static state and allocator metadata. A fresh instance gives the
    // browser the same process boundary as the native driver and makes phase/source recompilation
    // deterministic instead of retaining stale parser/JSL pointers in Wasm linear memory.
    await this.resetRuntime();
    this.result = null;
    this.output = '';
    const encoded = this.encoder.encode(source);
    const ptr = this.malloc(encoded.length + 1);
    this.u8.set(encoded, ptr); this.u8[ptr + encoded.length] = 0;
    try { this.instance.exports.graph_compile(ptr, encoded.length, phase); }
    finally { this.free(ptr); }
    if (!this.result) throw new Error(this.output || 'Compiler returned no graph');
    return this.result;
  }
}

export class GraphView {
  constructor(canvas, source) {
    this.canvas = canvas;
    this.source = source;
    this.ctx = canvas.getContext('2d');
    this.graph = null;
    this.positions = new Map();
    this.visible = new Set();
    this.selected = null;
    this.sourceSelection = new Set();
    this.focus = null;
    this.preset = 'all';
    this.edgeMode = 'all';
    this.pins = new Map();
    this.scale = 1;
    this.tx = 0; this.ty = 0;
    this.drag = null;
    this.drawFrame = null;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  bind() {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      const node = this.hitAt(event.offsetX, event.offsetY);
      const position = node === null ? null : this.positions.get(node);
      this.drag = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty,
        node, px: position?.x, py: position?.y, moved: false };
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.drag.node !== null) {
        const position = this.positions.get(this.drag.node);
        position.x = this.drag.px + dx / this.scale; position.y = this.drag.py + dy / this.scale;
        this.pins.set(this.drag.node, { x: position.x, y: position.y });
        document.getElementById('reset-pins').disabled = false;
      } else { this.tx = this.drag.tx + dx; this.ty = this.drag.ty + dy; }
      this.requestDraw();
    });
    this.canvas.addEventListener('pointerup', (event) => {
      if (this.drag && !this.drag.moved) this.selectAt(event.offsetX, event.offsetY, event.detail > 1);
      this.drag = null;
    });
    this.canvas.addEventListener('dblclick', (event) => this.selectAt(event.offsetX, event.offsetY, true));
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * .0012);
      const next = Math.max(.08, Math.min(3, this.scale * factor));
      const wx = (event.offsetX - this.tx) / this.scale, wy = (event.offsetY - this.ty) / this.scale;
      this.scale = next; this.tx = event.offsetX - wx * next; this.ty = event.offsetY - wy * next;
      this.requestDraw();
    }, { passive: false });
  }

  requestDraw() {
    if (this.drawFrame !== null) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * ratio); this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0); this.draw();
  }

  setGraph(graph) {
    this.graph = graph;
    this.selected = null; this.sourceSelection.clear(); this.focus = null;
    this.renderMachine(); this.rebuild(); this.fit();
  }

  setPreset(preset) { this.preset = preset; this.focus = null; this.rebuild(); this.fit(); }
  setEdgeMode(mode) { this.edgeMode = mode; this.draw(); }
  resetPins() { this.pins.clear(); document.getElementById('reset-pins').disabled = true; this.rebuild(); this.fit(); }

  hitAt(x, y) {
    const wx = (x - this.tx) / this.scale, wy = (y - this.ty) / this.scale;
    let hit = null;
    for (const [id, p] of this.positions) if (Math.abs(wx - p.x) <= p.w / 2 && Math.abs(wy - p.y) <= p.h / 2) hit = id;
    return hit;
  }

  baseVisible(node) {
    if (this.preset === 'all') return true;
    if (this.preset === 'memory') return ['control', 'call', 'memory', 'gc'].includes(node.kind);
    if (this.preset === 'values') return node.kind !== 'memory' && node.kind !== 'gc';
    return node.kind === 'control' || node.kind === 'call';
  }

  rebuild() {
    if (!this.graph) return;
    const nodes = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const owner = new Map();
    for (const node of this.graph.nodes) if (node.shape === 'projection') {
      const edge = this.graph.edges.find((item) => item.use === node.id && item.index === 0);
      if (edge) owner.set(node.id, edge.def);
    }
    const displayId = (id) => owner.get(id) ?? id;
    this.visible = new Set(this.graph.nodes.filter((node) => node.shape !== 'projection' && this.baseVisible(node)).map((node) => node.id));
    if (this.preset === 'control') {
      for (const edge of this.graph.edges) if (this.visible.has(displayId(edge.use)) && edge.index > 0) this.visible.add(displayId(edge.def));
    }
    if (this.focus !== null) {
      const near = new Set([this.focus]);
      for (let depth = 0; depth < 2; depth++) for (const edge of this.graph.edges) {
        if (near.has(edge.use) || near.has(edge.def)) { near.add(edge.use); near.add(edge.def); }
      }
      this.visible = near;
    }
    const visibleNodes = this.graph.nodes.filter((node) => this.visible.has(node.id))
      .map((node) => ({ ...node, anchor: displayId(node.anchor) }));
    const visibleEdges = this.graph.edges
      .filter((edge) => edge.index !== 0 || nodes.get(edge.use)?.shape !== 'projection')
      .map((edge) => ({ ...edge, use: displayId(edge.use), def: displayId(edge.def) }))
      .filter((edge) => edge.use !== edge.def && this.visible.has(edge.use) && this.visible.has(edge.def));
    this.displayEdges = visibleEdges;
    this.projections = new Map();
    for (const [projection, parent] of owner) {
      if (!this.visible.has(parent)) continue;
      if (!this.projections.has(parent)) this.projections.set(parent, []);
      this.projections.get(parent).push(nodes.get(projection));
    }
    for (const ports of this.projections.values()) ports.sort((a, b) => a.projectionIndex - b.projectionIndex || a.id - b.id);

    this.positions = controlIslandLayout(visibleNodes, visibleEdges, this.projections, this.pins);
    document.getElementById('counts').textContent = `${visibleNodes.length} / ${this.graph.nodes.length} nodes · ${visibleEdges.length} edges`;
    document.getElementById('clear-focus').disabled = this.focus === null;
    this.draw();
  }

  fit() {
    if (!this.positions.size) return;
    const rect = this.canvas.getBoundingClientRect();
    const xs = [...this.positions.values()].flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]);
    const ys = [...this.positions.values()].flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    this.scale = Math.min(1.15, Math.max(.06, Math.min((rect.width - 70) / Math.max(1, maxX - minX), (rect.height - 70) / Math.max(1, maxY - minY))));
    this.tx = rect.width / 2 - (minX + maxX) / 2 * this.scale;
    this.ty = rect.height / 2 - (minY + maxY) / 2 * this.scale;
    this.draw();
  }

  selectAt(x, y, focus) {
    const hit = this.hitAt(x, y);
    if (focus && hit !== null) { this.focus = hit; this.rebuild(); this.fit(); }
    if (hit === null) {
      this.selected = null; this.sourceSelection.clear(); this.inspect(); this.updateMachineSelection(); this.draw();
    } else this.select(hit);
  }

  select(id) {
    if (!this.visible.has(id)) { this.focus = id; this.rebuild(); this.fit(); }
    this.selected = id; this.sourceSelection.clear();
    const node = this.graph?.nodes.find((item) => item.id === id);
    if (node?.sourceLo >= 0) this.source.setSelectionRange(node.sourceLo, node.sourceHi);
    this.inspect(); this.updateMachineSelection(); this.draw();
  }

  selectSource(lo, hi) {
    if (!this.graph) return;
    const point = lo === hi;
    this.selected = null;
    this.sourceSelection = new Set(this.graph.nodes
      .filter((node) => node.sourceLo >= 0 && (point
        ? node.sourceLo <= lo && lo < node.sourceHi
        : node.sourceLo < hi && node.sourceHi > lo))
      .map((node) => node.id));
    this.inspect(); this.updateMachineSelection(); this.draw();
  }

  renderMachine() {
    const panel = document.getElementById('machine');
    if (!this.graph?.machine?.length) {
      panel.innerHTML = '<div class="machine-empty">Machine code is available after the Encoding phase.</div>';
      return;
    }
    panel.innerHTML = `<div class="machine-heading"><span>Address</span><span>Bytes</span><span>Instruction</span></div>${this.graph.machine.map((instruction) => {
      const bytes = instruction.bytes.match(/.{1,2}/g)?.join(' ') || '';
      return `<button class="machine-row" data-machine-node="${instruction.node}"><span>${instruction.address.toString(16).padStart(8, '0')}</span><code>${bytes}</code><strong>${escapeHtml(instruction.mnemonic)}</strong><small>#${instruction.node}</small></button>`;
    }).join('')}`;
    panel.querySelectorAll('[data-machine-node]').forEach((row) => row.onclick = () => this.select(Number(row.dataset.machineNode)));
  }

  updateMachineSelection() {
    document.querySelectorAll('[data-machine-node]').forEach((row) => {
      const id = Number(row.dataset.machineNode);
      const active = id === this.selected || this.sourceSelection.has(id);
      row.classList.toggle('active', active);
      if (id === this.selected) row.scrollIntoView({ block: 'nearest' });
    });
  }

  inspect() {
    const panel = document.getElementById('inspector');
    const node = this.graph?.nodes.find((item) => item.id === this.selected);
    if (!node) { panel.className = 'inspector-empty'; panel.textContent = 'Select a node to inspect its inputs and uses.'; return; }
    panel.className = '';
    const incoming = this.graph.edges.filter((edge) => edge.use === node.id);
    const uses = this.graph.edges.filter((edge) => edge.def === node.id);
    const byId = new Map(this.graph.nodes.map((item) => [item.id, item]));
    const links = (edges, input) => edges.map((edge) => {
      const other = byId.get(input ? edge.def : edge.use);
      return `<button class="edge-link" data-node="${other.id}"><span>#${other.id} ${escapeHtml(other.label)}</span><span>${input ? edge.index : edge.kind}</span></button>`;
    }).join('') || '<div class="inspector-empty">none</div>';
    panel.innerHTML = `<div class="node-heading"><span class="badge">#${node.id}</span><strong>${escapeHtml(node.label)}</strong></div>
      <dl class="property-list"><dt>kind</dt><dd>${node.kind}</dd><dt>opcode</dt><dd>${node.op}</dd><dt>phase</dt><dd>${this.graph.phase}</dd><dt>status</dt><dd>${escapeHtml(this.graph.status)}</dd></dl>
      <div class="edge-list-title">Inputs</div>${links(incoming, true)}
      <div class="edge-list-title">Uses</div>${links(uses, false)}`;
    panel.querySelectorAll('[data-node]').forEach((button) => button.onclick = () => this.select(Number(button.dataset.node)));
  }

  draw() {
    const ctx = this.ctx, rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!this.graph) return;
    const selectedNear = new Set();
    if (this.selected !== null) for (const edge of this.displayEdges || []) if (edge.use === this.selected || edge.def === this.selected) { selectedNear.add(edge.use); selectedNear.add(edge.def); }
    ctx.save(); ctx.translate(this.tx, this.ty); ctx.scale(this.scale, this.scale);
    for (const edge of this.displayEdges || []) {
      const a = this.positions.get(edge.def), b = this.positions.get(edge.use);
      if (!a || !b) continue;
      const related = edge.use === this.selected || edge.def === this.selected;
      const sourceRelated = this.sourceSelection.has(edge.use) || this.sourceSelection.has(edge.def);
      const structural = edge.kind === 'control' || edge.style === 'dotted';
      if (this.edgeMode === 'structure' && !structural) continue;
      if (this.edgeMode === 'related' && !structural && !related) continue;
      const highlighted = this.sourceSelection.size ? sourceRelated : this.selected === null || related;
      ctx.globalAlpha = highlighted ? .82 : .08;
      ctx.strokeStyle = edgeColors[edge.kind] || edgeColors.value;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = highlighted ? 1.6 / this.scale ** .2 : .9;
      ctx.setLineDash(edge.style === 'dotted' ? [2, 5] : edge.style === 'dashed' ? [7, 5] : []);
      const sx = b.x, sy = b.y - b.h / 2, ex = a.x, ey = a.y + a.h / 2;
      const direction = edge.kind === 'control' ? -1 : edge.kind === 'memory' ? 1 : 0;
      const lane = direction ? direction * (90 + (edge.index % 5) * 18) : 0;
      const bend = edge.rank ? (sy + ey) / 2 : Math.max(sy, ey) + 90 + (edge.index % 4) * 18;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      if (lane) {
        const channel = (direction < 0 ? Math.min(sx, ex) : Math.max(sx, ex)) + lane;
        ctx.lineTo(channel, sy); ctx.lineTo(channel, ey); ctx.lineTo(ex, ey);
      } else { ctx.bezierCurveTo(sx, bend, ex, bend, ex, ey); }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 4, ey + 8); ctx.lineTo(ex + 4, ey + 8); ctx.closePath(); ctx.fill();
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(String(edge.index), sx + 5, sy - 2);
    }
    ctx.setLineDash([]);
    for (const node of this.graph.nodes) {
      const p = this.positions.get(node.id); if (!p) continue;
      const selected = node.id === this.selected;
      const sourceMatched = this.sourceSelection.has(node.id);
      const dim = this.sourceSelection.size
        ? !sourceMatched
        : this.selected !== null && !selected && !selectedNear.has(node.id);
      ctx.globalAlpha = dim ? .24 : 1;
      const fill = nodeColors[node.color] || nodeColors.unknown;
      ctx.fillStyle = fill; ctx.strokeStyle = selected || sourceMatched ? '#ffffff' : '#18202b'; ctx.lineWidth = selected || sourceMatched ? 3 : 1.25;
      if (node.shape === 'phi' || node.shape === 'value') {
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.w / 2, p.h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        roundRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 3); ctx.fill(); ctx.stroke();
        if (node.shape === 'function') { roundRect(ctx, p.x - p.w / 2 + 4, p.y - p.h / 2 + 4, p.w - 8, p.h - 8, 2); ctx.stroke(); }
      }
      const ports = this.projections.get(node.id) || [];
      if (ports.length) {
        const portWidth = p.w / ports.length, top = p.y + p.h / 2 - 22;
        ctx.strokeStyle = '#263141'; ctx.lineWidth = 1;
        ports.forEach((port, index) => {
          const left = p.x - p.w / 2 + index * portWidth;
          ctx.fillStyle = nodeColors[port.color] || fill; ctx.fillRect(left, top, portWidth, 22); ctx.strokeRect(left, top, portWidth, 22);
          ctx.fillStyle = '#17202a'; ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const text = port.label.length > 10 ? `${port.label.slice(0, 9)}…` : port.label;
          ctx.fillText(text, left + portWidth / 2, top + 11);
        });
      }
      ctx.fillStyle = '#17202a'; ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = `${node.label} #${node.id}`;
      ctx.fillText(label.length > 22 ? `${label.slice(0, 21)}…` : label, p.x, p.y - (ports.length ? 10 : 0));
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }
}

function roundRect(ctx, x, y, w, h, radius) {
  radius = Math.min(radius, w / 2, h / 2); ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
}
function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }

function controlIslandLayout(nodes, edges, projections, pins) {
  const positions = new Map();
  const controls = nodes.filter((node) => node.kind === 'control' || node.kind === 'call');
  const controlIds = new Set(controls.map((node) => node.id));
  const controlEdges = edges.filter((edge) => controlIds.has(edge.use) && controlIds.has(edge.def));
  const ranks = semanticRanks(controls, controlEdges);
  const rows = new Map();
  for (const node of controls) {
    const rank = ranks.get(node.id) || 0;
    if (!rows.has(rank)) rows.set(rank, []);
    rows.get(rank).push(node);
  }
  orderRows(rows, controlEdges);
  for (const [rank, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    const gap = 330;
    row.forEach((node, index) => {
      const ports = projections.get(node.id)?.length || 0;
      positions.set(node.id, { x: (index - (row.length - 1) / 2) * gap, y: rank * 250,
        w: Math.max(126, ports * 78), h: ports ? 66 : 46 });
    });
  }

  // Floating values live in compact islands owned by the compiler-published control anchor. The
  // layout never guesses ownership from opcode names. Islands use dependency rank and median order
  // locally, keeping most value edges short while control edges retain a readable global spine.
  const islands = new Map();
  for (const node of nodes) if (!controlIds.has(node.id)) {
    const anchor = controlIds.has(node.anchor) ? node.anchor : -1;
    if (!islands.has(anchor)) islands.set(anchor, []);
    islands.get(anchor).push(node);
  }
  let orphanX = 0;
  for (const [anchor, island] of islands) {
    const ids = new Set(island.map((node) => node.id));
    const localEdges = edges.filter((edge) => ids.has(edge.use) && ids.has(edge.def));
    const localRanks = semanticRanks(island, localEdges);
    const localRows = new Map();
    for (const node of island) {
      const rank = localRanks.get(node.id) || 0;
      if (!localRows.has(rank)) localRows.set(rank, []);
      localRows.get(rank).push(node);
    }
    orderRows(localRows, localEdges);
    const base = positions.get(anchor) || { x: orphanX, y: -230 };
    let depth = 0;
    for (const [, row] of [...localRows].sort((a, b) => a[0] - b[0])) {
      row.forEach((node, index) => {
        const ports = projections.get(node.id)?.length || 0;
        positions.set(node.id, { x: base.x + 185 + index * 145, y: base.y - 72 - depth * 82,
          w: Math.max(112, ports * 76), h: ports ? 62 : 42 });
      });
      depth++;
    }
    if (anchor === -1) orphanX += Math.max(360, ...[...localRows.values()].map((row) => row.length * 145));
  }
  for (const [id, pin] of pins) {
    const position = positions.get(id);
    if (position) { position.x = pin.x; position.y = pin.y; position.pinned = true; }
  }
  return positions;
}

function semanticRanks(nodes, edges) {
  const ids = nodes.map((node) => node.id), outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) if (edge.rank && edge.style !== 'dotted') outgoing.get(edge.def)?.push(edge.use);
  let nextIndex = 0;
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
  function visit(id) {
    index.set(id, nextIndex); low.set(id, nextIndex++); stack.push(id); onStack.add(id);
    for (const use of outgoing.get(id) || []) {
      if (!index.has(use)) { visit(use); low.set(id, Math.min(low.get(id), low.get(use))); }
      else if (onStack.has(use)) low.set(id, Math.min(low.get(id), index.get(use)));
    }
    if (low.get(id) === index.get(id)) {
      const component = [];
      while (stack.length) { const member = stack.pop(); onStack.delete(member); component.push(member); if (member === id) break; }
      components.push(component);
    }
  }
  for (const id of ids) if (!index.has(id)) visit(id);
  const componentOf = new Map();
  components.forEach((members, component) => members.forEach((id) => componentOf.set(id, component)));
  const dag = new Map(components.map((_, component) => [component, new Set()]));
  const indegree = new Map(components.map((_, component) => [component, 0]));
  for (const [def, uses] of outgoing) for (const use of uses) {
    const from = componentOf.get(def), to = componentOf.get(use);
    if (from !== to && !dag.get(from).has(to)) { dag.get(from).add(to); indegree.set(to, indegree.get(to) + 1); }
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([component]) => component).sort((a, b) => a - b);
  const componentRank = new Map(components.map((_, component) => [component, 0]));
  while (queue.length) {
    const component = queue.shift();
    for (const use of dag.get(component)) {
      componentRank.set(use, Math.max(componentRank.get(use), componentRank.get(component) + 1));
      indegree.set(use, indegree.get(use) - 1);
      if (indegree.get(use) === 0) queue.push(use);
    }
  }
  return new Map(ids.map((id) => [id, componentRank.get(componentOf.get(id)) || 0]));
}

function orderRows(rows, edges) {
  for (const row of rows.values()) row.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  const neighbors = new Map();
  for (const edge of edges) {
    if (!neighbors.has(edge.use)) neighbors.set(edge.use, []);
    if (!neighbors.has(edge.def)) neighbors.set(edge.def, []);
    neighbors.get(edge.use).push(edge.def); neighbors.get(edge.def).push(edge.use);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  for (let sweep = 0; sweep < 6; sweep++) {
    const sequence = sweep % 2 ? [...ordered].reverse() : ordered;
    const positions = new Map();
    for (const [, row] of ordered) row.forEach((node, at) => positions.set(node.id, at));
    for (const [, row] of sequence) row.sort((a, b) => {
      const center = (node) => {
        const ns = (neighbors.get(node.id) || []).filter((id) => positions.has(id));
        return ns.length ? ns.reduce((sum, id) => sum + positions.get(id), 0) / ns.length : positions.get(node.id);
      };
      return center(a) - center(b) || a.id - b.id;
    });
  }
}

async function startGraphLab() {
  const source = document.getElementById('source');
  const status = document.getElementById('status');
  const compileButton = document.getElementById('compile');
  const empty = document.getElementById('empty-state');
  const view = new GraphView(document.getElementById('graph'), source);
  const host = new WasmHost();
  const phaseTrack = document.getElementById('phase');
  const phaseButtons = [];
  PHASES.forEach(([name, description], index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'phase-step'; button.dataset.phase = String(index + 1);
    button.setAttribute('role', 'option'); button.title = description;
    button.innerHTML = `<span>${index + 1}</span><strong>${name}</strong>`;
    phaseTrack.append(button); phaseButtons.push(button);
  });
  let phase = 3;

  function showPhase() {
    phaseButtons.forEach((button, index) => {
      const active = index + 1 === phase;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      if (active) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  showPhase();

  source.value = EXAMPLES.object;
  document.getElementById('example').onchange = async (event) => {
    view.pins.clear(); document.getElementById('reset-pins').disabled = true;
    source.value = EXAMPLES[event.target.value];
    await compile();
  };

  async function compile() {
  compileButton.disabled = true; status.textContent = 'Compiling in Coil/Wasm…';
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const started = performance.now();
    const graph = await host.compile(source.value, phase);
    view.setGraph(graph); empty.hidden = true;
    status.textContent = graph.status === 'complete'
      ? `${graph.phase} · ${graph.nodes.length} nodes · ${(performance.now() - started).toFixed(0)} ms`
      : `${graph.phase} · ${graph.status}`;
  } catch (error) {
    status.textContent = 'Compilation failed';
    empty.hidden = false; empty.textContent = error.message;
  } finally { compileButton.disabled = false; }
  }

  compileButton.onclick = compile;
  source.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); compile(); } });
  source.addEventListener('click', () => view.selectSource(source.selectionStart, source.selectionEnd));
  source.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
      view.selectSource(source.selectionStart, source.selectionEnd);
  });
  async function setPhase(next) {
    phase = Math.max(1, Math.min(PHASES.length, next)); showPhase();
    await compile();
  }
  phaseTrack.onclick = (event) => {
    const button = event.target.closest('[data-phase]');
    if (button) setPhase(Number(button.dataset.phase));
  };
  document.getElementById('previous-phase').onclick = () => setPhase(phase - 1);
  document.getElementById('next-phase').onclick = () => setPhase(phase + 1);
  document.querySelectorAll('[data-preset]').forEach((button) => button.onclick = () => {
    document.querySelectorAll('[data-preset]').forEach((item) => item.classList.toggle('active', item === button));
    view.setPreset(button.dataset.preset);
  });
  document.querySelectorAll('[data-edges]').forEach((button) => button.onclick = () => {
    document.querySelectorAll('[data-edges]').forEach((item) => item.classList.toggle('active', item === button));
    view.setEdgeMode(button.dataset.edges);
  });
  document.getElementById('fit').onclick = () => view.fit();
  document.getElementById('relayout').onclick = () => { view.rebuild(); view.fit(); };
  document.getElementById('reset-pins').onclick = () => view.resetPins();
  document.getElementById('clear-focus').onclick = () => { view.focus = null; view.rebuild(); view.fit(); };
  document.querySelectorAll('[data-detail]').forEach((button) => button.onclick = () => {
    document.querySelectorAll('[data-detail]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.detail-content').forEach((panel) => { panel.hidden = panel.id !== button.dataset.detail; });
  });
  document.getElementById('search').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !view.graph) return;
    const query = event.target.value.trim().toLowerCase();
    const node = view.graph.nodes.find((item) => String(item.id) === query.replace(/^#/, '') || item.label.toLowerCase().includes(query));
    if (node) view.select(node.id);
  });

  try {
    await host.load();
    status.textContent = 'Coil/Wasm ready';
    compileButton.disabled = false;
    await compile();
  } catch (error) {
    status.textContent = 'Unable to load compiler'; empty.textContent = error.message; console.error(error);
  }
}

if (typeof document !== 'undefined') await startGraphLab();
