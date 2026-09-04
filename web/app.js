const INITIAL_SOURCE = `function main() {
  let node = { left: 1, right: 2, item: 3 };
  return node.item;
}`;

const colors = {
  control: '#f0a44b', value: '#89a8d8', memory: '#56c2b5', dynamic: '#c18be0',
  property: '#dd83a4', gc: '#f06f6f', call: '#7ebc76', projection: '#8996a8'
};

class WasmHost {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.heapTop = 0;
    this.freeBins = new Map();
    this.files = new Map();
    this.fds = new Map();
    this.nextFd = 3;
    this.result = null;
    this.output = '';
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
    const indexText = await fetch('../jsl/compiler/index').then((response) => response.text());
    this.files.set('jsl/compiler/index', this.encoder.encode(indexText));
    const paths = indexText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    await Promise.all(paths.map(async (path) => {
      const response = await fetch(`../${path}`);
      if (!response.ok) throw new Error(`Unable to load ${path}: ${response.status}`);
      this.files.set(path, new Uint8Array(await response.arrayBuffer()));
    }));
    const bytes = await fetch('aot-graph.wasm').then((response) => response.arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, this.imports());
    this.instance = instance;
    this.memory = instance.exports.memory;
    this.heapTop = Number(instance.exports.__heap_base.value);
  }

  compile(source, phase) {
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

class GraphView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.graph = null;
    this.positions = new Map();
    this.visible = new Set();
    this.selected = null;
    this.focus = null;
    this.preset = 'control';
    this.scale = 1;
    this.tx = 0; this.ty = 0;
    this.drag = null;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  bind() {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty, moved: false };
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.tx = this.drag.tx + dx; this.ty = this.drag.ty + dy; this.draw();
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
      this.scale = next; this.tx = event.offsetX - wx * next; this.ty = event.offsetY - wy * next; this.draw();
    }, { passive: false });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * ratio); this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0); this.draw();
  }

  setGraph(graph) {
    this.graph = graph;
    this.selected = null; this.focus = null;
    this.rebuild(); this.fit();
  }

  setPreset(preset) { this.preset = preset; this.focus = null; this.rebuild(); this.fit(); }

  baseVisible(node) {
    if (this.preset === 'all') return true;
    if (this.preset === 'memory') return ['control', 'call', 'memory', 'gc'].includes(node.kind);
    if (this.preset === 'values') return node.kind !== 'memory' && node.kind !== 'gc';
    return node.kind === 'control' || node.kind === 'call';
  }

  rebuild() {
    if (!this.graph) return;
    const nodes = new Map(this.graph.nodes.map((node) => [node.id, node]));
    this.visible = new Set(this.graph.nodes.filter((node) => this.baseVisible(node)).map((node) => node.id));
    if (this.preset === 'control') {
      for (const edge of this.graph.edges) if (this.visible.has(edge.use) && edge.index > 0) this.visible.add(edge.def);
    }
    if (this.focus !== null) {
      const near = new Set([this.focus]);
      for (let depth = 0; depth < 2; depth++) for (const edge of this.graph.edges) {
        if (near.has(edge.use) || near.has(edge.def)) { near.add(edge.use); near.add(edge.def); }
      }
      this.visible = near;
    }
    const visibleNodes = this.graph.nodes.filter((node) => this.visible.has(node.id));
    const visibleEdges = this.graph.edges.filter((edge) => this.visible.has(edge.use) && this.visible.has(edge.def));
    const rank = new Map(visibleNodes.map((node) => [node.id, 0]));
    for (let pass = 0; pass < Math.min(visibleNodes.length, 28); pass++) {
      let changed = false;
      for (const edge of visibleEdges) {
        if (edge.index === 2 && ['Phi', 'Loop'].includes(nodes.get(edge.use)?.label)) continue;
        const next = Math.min(24, (rank.get(edge.def) || 0) + 1);
        if (next > (rank.get(edge.use) || 0)) { rank.set(edge.use, next); changed = true; }
      }
      if (!changed) break;
    }
    const rows = new Map();
    for (const node of visibleNodes) {
      const r = rank.get(node.id) || 0;
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push(node);
    }
    this.positions.clear();
    const rowGap = 105, colGap = 150, maxColumns = 8;
    let displayRow = 0;
    for (const [, row] of [...rows].sort((a, b) => a[0] - b[0])) {
      row.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
      for (let offset = 0; offset < row.length; offset += maxColumns) {
        const group = row.slice(offset, offset + maxColumns);
        const width = (group.length - 1) * colGap;
        group.forEach((node, index) => this.positions.set(node.id, {
          x: index * colGap - width / 2,
          y: -displayRow * rowGap,
          w: 112,
          h: 38
        }));
        displayRow++;
      }
    }
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
    const wx = (x - this.tx) / this.scale, wy = (y - this.ty) / this.scale;
    let hit = null;
    for (const [id, p] of this.positions) if (Math.abs(wx - p.x) <= p.w / 2 && Math.abs(wy - p.y) <= p.h / 2) hit = id;
    this.selected = hit;
    if (focus && hit !== null) { this.focus = hit; this.rebuild(); this.fit(); }
    this.inspect(); this.draw();
  }

  select(id) { if (!this.visible.has(id)) { this.focus = id; this.rebuild(); this.fit(); } this.selected = id; this.inspect(); this.draw(); }

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
      <dl class="property-list"><dt>kind</dt><dd>${node.kind}</dd><dt>opcode</dt><dd>${node.op}</dd><dt>phase</dt><dd>${this.graph.phase}</dd></dl>
      <div class="edge-list-title">Inputs</div>${links(incoming, true)}
      <div class="edge-list-title">Uses</div>${links(uses, false)}`;
    panel.querySelectorAll('[data-node]').forEach((button) => button.onclick = () => this.select(Number(button.dataset.node)));
  }

  draw() {
    const ctx = this.ctx, rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!this.graph) return;
    const selectedNear = new Set();
    if (this.selected !== null) for (const edge of this.graph.edges) if (edge.use === this.selected || edge.def === this.selected) { selectedNear.add(edge.use); selectedNear.add(edge.def); }
    ctx.save(); ctx.translate(this.tx, this.ty); ctx.scale(this.scale, this.scale);
    for (const edge of this.graph.edges) {
      const a = this.positions.get(edge.def), b = this.positions.get(edge.use);
      if (!a || !b) continue;
      const highlighted = this.selected === null || edge.use === this.selected || edge.def === this.selected;
      ctx.globalAlpha = highlighted ? .58 : .07;
      ctx.strokeStyle = colors[edge.kind] || colors.value;
      ctx.lineWidth = highlighted ? 1.35 / this.scale ** .2 : .8;
      if (edge.kind === 'memory') ctx.setLineDash([5, 4]); else ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y - a.h / 2);
      const mid = (a.y + b.y) / 2;
      ctx.bezierCurveTo(a.x, mid, b.x, mid, b.x, b.y + b.h / 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const node of this.graph.nodes) {
      const p = this.positions.get(node.id); if (!p) continue;
      const selected = node.id === this.selected, dim = this.selected !== null && !selected && !selectedNear.has(node.id);
      ctx.globalAlpha = dim ? .24 : 1;
      ctx.fillStyle = '#131b26'; ctx.strokeStyle = colors[node.kind] || colors.value; ctx.lineWidth = selected ? 3 : 1.25;
      roundRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, node.kind === 'control' ? 4 : 12); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#dce5f2'; ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = `${node.label} #${node.id}`; ctx.fillText(label.length > 18 ? `${label.slice(0, 17)}…` : label, p.x, p.y);
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }
}

function roundRect(ctx, x, y, w, h, radius) {
  radius = Math.min(radius, w / 2, h / 2); ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
}
function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }

const source = document.getElementById('source');
const status = document.getElementById('status');
const compileButton = document.getElementById('compile');
const empty = document.getElementById('empty-state');
const view = new GraphView(document.getElementById('graph'));
const host = new WasmHost();
let phase = 1;

source.value = INITIAL_SOURCE;
document.getElementById('reset-source').onclick = () => { source.value = INITIAL_SOURCE; };

async function compile() {
  compileButton.disabled = true; status.textContent = 'Compiling in Coil/Wasm…';
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const started = performance.now();
    const graph = host.compile(source.value, phase);
    view.setGraph(graph); empty.hidden = true;
    status.textContent = `${graph.phase} · ${graph.nodes.length} nodes · ${(performance.now() - started).toFixed(0)} ms`;
  } catch (error) {
    status.textContent = 'Compilation failed';
    empty.hidden = false; empty.textContent = error.message;
  } finally { compileButton.disabled = false; }
}

compileButton.onclick = compile;
source.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); compile(); } });
document.querySelectorAll('[data-phase]').forEach((button) => button.onclick = () => {
  phase = Number(button.dataset.phase);
  document.querySelectorAll('[data-phase]').forEach((item) => item.classList.toggle('active', item === button));
  compile();
});
document.querySelectorAll('[data-preset]').forEach((button) => button.onclick = () => {
  document.querySelectorAll('[data-preset]').forEach((item) => item.classList.toggle('active', item === button));
  view.setPreset(button.dataset.preset);
});
document.getElementById('fit').onclick = () => view.fit();
document.getElementById('clear-focus').onclick = () => { view.focus = null; view.rebuild(); view.fit(); };
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
