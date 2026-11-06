/**
 * Browser-half smoke test for the Dremu chart studio.
 *
 * There is no DOM in this process, so this file implements a deliberately tiny
 * React-compatible runtime (function components, useState/useEffect/useMemo/
 * useRef/useCallback, host elements, refs) plus the handful of browser globals
 * `client.js` touches. It then mounts the real page and asserts that:
 *
 *   1. the module evaluates and registers a client plugin,
 *   2. the page renders in its loading, empty and project states without
 *      throwing,
 *   3. the timeline canvas paints through a stub 2D context,
 *   4. the inspector and curve dialog render a real element/catalog,
 *   5. a curve dialog Apply produces the expected value.
 *
 * Run: node tests/client-smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

// ---------------------------------------------------------------------------
// Browser globals
// ---------------------------------------------------------------------------

/** All 2D contexts created by the harness (for canvas text-layout assertions). */
const canvasContexts = [];

/**
 * Deferred animation frames. A browser runs rAF callbacks; this harness must
 * not let the page animate on its own (that would make the assertions
 * nondeterministic), so callbacks are queued and only a test may flush them.
 * The playback-preview smoke test flushes a few frames after opening the
 * overlay, which is exactly one browser frame's worth of scheduled work.
 */
let animationFrameSeq = 0;
const animationFrameQueue = new Map();
function flushAnimationFrames(rounds = 1) {
  let ran = 0;
  for (let round = 0; round < rounds; round += 1) {
    if (animationFrameQueue.size === 0) break;
    const queued = Array.from(animationFrameQueue.values());
    animationFrameQueue.clear();
    for (const callback of queued) {
      ran += 1;
      callback();
    }
  }
  return ran;
}

/** Rough text width in the current font: CJK glyphs are square, latin ~0.55em. */
function estimateTextWidth(text, font) {
  const match = /(\d+(?:\.\d+)?)px/.exec(String(font || '11px sans-serif'));
  const size = match ? Number(match[1]) : 11;
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code >= 0x2e80) width += size; // CJK, full-width punctuation
    else if (char === ' ') width += size * 0.28;
    else width += size * 0.56;
  }
  return width;
}

/** Stub 2D context: unknown properties are no-op methods, text is recorded. */
function makeContext2D() {
  const state = {
    canvas: null,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    drawn: [],
    rects: [],
    // Independent path/paint recorder for the Autoplay playback preview.
    // Kept apart from `drawn`/`rects` (the timeline text-layout assertions)
    // so both recorders can be trusted on their own frames.
    ops: [],
    path: [],
    fillStyle: '#fff',
    strokeStyle: '#fff',
    lineWidth: 1,
    globalAlpha: 1,
  };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') {
        return (text) => ({ width: estimateTextWidth(text, target.font) });
      }
      if (prop === 'fillRect' || prop === 'strokeRect') {
        return (x, y, w, h) => {
          target.rects.push({ x, y, w, h, kind: prop });
        };
      }
      if (prop === 'clearRect') {
        // A paint always clears first: treat it as the frame boundary so the
        // recorder only ever holds the most recent frame. This resets the
        // text frame as well as the path/paint ops frame.
        return () => {
          target.drawn = [];
          target.rects = [];
          target.ops = [];
          target.path = [];
        };
      }
      if (prop === 'fillText') {
        return (text, x, y) => {
          const width = estimateTextWidth(text, target.font);
          const align = target.textAlign || 'left';
          const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
          target.drawn.push({ text: String(text), x: left, y, width, font: target.font });
        };
      }
      // ---- Path/paint recorder (Autoplay playback preview) --------------
      // The preview canvas paints its lanes/holds/notes through paths and
      // strokes; recording them proves the frame actually reached the canvas.
      if (prop === 'beginPath') {
        return () => {
          target.path = [];
        };
      }
      if (prop === 'closePath') {
        return () => {
          target.path.push({ op: 'close' });
        };
      }
      if (prop === 'moveTo') {
        return (x, y) => {
          target.path.push({ op: 'moveTo', x, y });
        };
      }
      if (prop === 'lineTo') {
        return (x, y) => {
          target.path.push({ op: 'lineTo', x, y });
        };
      }
      if (prop === 'arc') {
        return (x, y, r) => {
          target.path.push({ op: 'arc', x, y, r });
        };
      }
      if (prop === 'rect') {
        return (x, y, w, h) => {
          target.path.push(
            { op: 'moveTo', x, y },
            { op: 'lineTo', x: x + w, y },
            { op: 'lineTo', x: x + w, y: y + h },
            { op: 'lineTo', x, y: y + h },
          );
        };
      }
      if (prop === 'quadraticCurveTo') {
        return (cx, cy, x, y) => {
          target.path.push({ op: 'quadraticCurveTo', x, y });
        };
      }
      if (prop === 'bezierCurveTo') {
        return (c1x, c1y, c2x, c2y, x, y) => {
          target.path.push({ op: 'bezierCurveTo', x, y });
        };
      }
      if (prop === 'stroke') {
        return () => {
          target.ops.push({
            op: 'stroke',
            path: target.path.slice(),
            lineWidth: target.lineWidth,
            strokeStyle: target.strokeStyle,
            globalAlpha: target.globalAlpha,
          });
        };
      }
      if (prop === 'fill') {
        return () => {
          target.ops.push({
            op: 'fill',
            path: target.path.slice(),
            fillStyle: target.fillStyle,
            globalAlpha: target.globalAlpha,
          });
        };
      }
      if (prop === 'drawImage') {
        return (...args) => {
          target.ops.push({ op: 'drawImage', args, globalAlpha: target.globalAlpha });
        };
      }

      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'setTransform' || prop === 'clearRect') return () => undefined;
      if (typeof prop === 'string' && /^[a-z]/.test(prop) && prop[0] === prop[0].toLowerCase()) return () => undefined;
      return undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

/** Fake DOM element sufficient for the components' ref usage. */
function makeElement(tag) {
  const style = {};
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style,
    dataset: {},
    children: [],
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 420,
    className: '',
    value: '',
    type: '',
    checked: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      return child;
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    click() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getContext() {
      if (!this._ctx) {
        this._ctx = makeContext2D();
        // Back-reference so a test can tell which canvas a context painted.
        this._ctx.__element = this;
        canvasContexts.push(this._ctx);
      }
      return this._ctx;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 420, width: 800, height: 420, x: 0, y: 0 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    contains() {
      return false;
    },
  };
  return node;
}

/** A DOM element whose children mirror the rendered tree (for text asserts). */
function makeHostNode(tag, props) {
  const node = makeElement(tag);
  node.className = props && props.className ? props.className : '';
  return node;
}

/** Minimal document/window implementation. */
function installGlobals() {
  const documentElement = makeElement('html');
  documentElement.isContentEditable = false;
  const doc = {
    documentElement,
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const win = {
    document: doc,
    devicePixelRatio: 2,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() {
      return { getPropertyValue: () => '' };
    },
    requestAnimationFrame(callback) {
      // Queue instead of running: the page must not animate on its own. A test
      // that wants a frame calls flushAnimationFrames().
      animationFrameSeq += 1;
      animationFrameQueue.set(animationFrameSeq, callback);
      return animationFrameSeq;
    },
    cancelAnimationFrame(id) {
      animationFrameQueue.delete(id);
    },
    setTimeout,
    clearTimeout,
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    fetch: (url, options) => mockFetch(url, options),
    EventSource: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
      }
      close() {}
    },
    Audio: class {
      constructor() {
        this.playbackRate = 1;
        this.muted = false;
        this.currentTime = 0;
        this.duration = 0;
        this.error = null;
        this.preload = 'auto';
        this.src = '';
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
      addEventListener() {}
      removeEventListener() {}
      removeAttribute() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
      disconnect() {}
    },
    OfflineAudioContext: undefined,
    AudioContext: undefined,
    performance: { now: () => Date.now() },
  };
  win.window = win;
  win.globalThis = globalThis;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.performance = win.performance;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.ResizeObserver = win.ResizeObserver;
  globalThis.MutationObserver = win.MutationObserver;
  globalThis.EventSource = win.EventSource;
  globalThis.Audio = win.Audio;
  globalThis.fetch = win.fetch;
  return win;
}

// ---------------------------------------------------------------------------
// Tiny React runtime
// ---------------------------------------------------------------------------

const hookSlots = [];
let renderCursor = 0;
let activeSlot = null;
let scheduled = false;
let mountedRoot = null;
let effectQueue = [];

function slotFor(index, type) {
  // A different component type at the same tree position is a remount: React
  // discards the old fibre (and its hook state), so the harness must too.
  if (!hookSlots[index] || hookSlots[index].type !== type) {
    hookSlots[index] = { type, hooks: [], cursor: 0 };
  }
  return hookSlots[index];
}

function scheduleRender() {
  scheduled = true;
}

function readDeps(deps) {
  return Array.isArray(deps) ? deps.slice() : null;
}

function depsChanged(previous, next) {
  if (!previous || !next) return true;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return true;
  return false;
}

function nextHook() {
  const slot = activeSlot;
  const index = slot.cursor;
  slot.cursor += 1;
  if (slot.hooks.length <= index) slot.hooks[index] = {};
  return slot.hooks[index];
}

const React = {
  createElement(type, props, ...children) {
    const merged = children.length === 0 ? props || {} : Object.assign({}, props || {}, { children: children.length === 1 ? children[0] : children });
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push);
      else if (child !== undefined) flat.push(child);
    };
    push(merged.children);
    const normalized = Object.assign({}, merged);
    if (flat.length === 0) delete normalized.children;
    else normalized.children = flat.length === 1 ? flat[0] : flat;
    return { $$typeof: 'element', type, props: normalized };
  },
  useState(initial) {
    const hook = nextHook();
    if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial;
    const setState = (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (Object.is(value, hook.value)) return;
      hook.value = value;
      scheduleRender();
    };
    return [hook.value, setState];
  },
  useRef(initial) {
    const hook = nextHook();
    if (!('ref' in hook)) hook.ref = { current: initial };
    return hook.ref;
  },
  // Faithful-enough memoisation: an unchanged dependency list keeps the cached
  // value, exactly like React. Without this every render would hand effects new
  // callback identities and re-fire them (which is not what the real runtime
  // does, and it hid a real undo bug during review).
  useMemo(factory, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (!('memo' in hook) || depsChanged(hook.deps, nextDeps)) {
      hook.memo = factory();
      hook.deps = nextDeps;
    }
    return hook.memo;
  },
  useCallback(callback, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (!('callback' in hook) || depsChanged(hook.deps, nextDeps)) {
      hook.callback = callback;
      hook.deps = nextDeps;
    }
    return hook.callback;
  },
  useEffect(effect, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (hook.cleanup && depsChanged(hook.deps, nextDeps)) {
      try {
        hook.cleanup();
      } catch (error) {
        /* ignore cleanup failures in the harness */
      }
      hook.cleanup = undefined;
    }
    if (depsChanged(hook.deps, nextDeps)) {
      hook.deps = nextDeps;
      effectQueue.push({ hook, effect });
    }
  },
  useLayoutEffect(effect, deps) {
    React.useEffect(effect, deps);
  },
  useDebugValue() {},
  // The plugin memoises a few panes; the harness renders eagerly.
  memo(component) {
    return component;
  },
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
  },
};

function renderNode(node) {
  if (node === null || node === undefined || node === true || node === false) return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (node.$$typeof !== 'element') return null;
  const type = node.type;
  const props = node.props || {};
  if (typeof type === 'function') {
    const previous = activeSlot;
    activeSlot = slotFor(renderCursor, type);
    renderCursor += 1;
    activeSlot.cursor = 0;
    let output;
    try {
      output = type(props);
    } finally {
      activeSlot = previous;
    }
    const rendered = renderNode(output);
    const host = { component: type, rendered };
    return host;
  }
  const hostNode = makeHostNode(type, props);
  hostNode.props = props;
  if (props.ref !== undefined && props.ref !== null && typeof props.ref === 'object') props.ref.current = hostNode;
  const children = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children];
  hostNode.rendered = children.map(renderNode);
  return hostNode;
}

function flattenText(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenText(child, out));
    return out;
  }
  if (node.text !== undefined) {
    out.push(node.text);
    return out;
  }
  if (node.rendered !== undefined) flattenText(node.rendered, out);
  if (node.rendered === undefined && node.children) flattenText(node.children, out);
  return out;
}

function flattenHosts(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenHosts(child, out));
    return out;
  }
  if (node.text !== undefined) return out;
  if (node.tagName) out.push(node);
  if (node.rendered !== undefined) flattenHosts(node.rendered, out);
  return out;
}

function flattenComponents(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenComponents(child, out));
    return out;
  }
  if (node.component) out.push(node.component);
  if (node.rendered !== undefined) flattenComponents(node.rendered, out);
  return out;
}

/** Run queued effects, then re-render while something scheduled a change. */
async function settle(maxPasses = 6) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const queue = effectQueue;
    effectQueue = [];
    for (const item of queue) {
      try {
        const cleanup = item.effect();
        if (typeof cleanup === 'function') item.hook.cleanup = cleanup;
      } catch (error) {
        throw new Error('effect threw: ' + (error && error.stack ? error.stack : error));
      }
    }
    // Let promise-based effects (fetch) resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!scheduled) break;
    scheduled = false;
    renderCursor = 0;
    mountedRoot.tree = renderNode(mountedRoot.element);
  }
  return mountedRoot.tree;
}

function mount(element) {
  hookSlots.length = 0;
  renderCursor = 0;
  activeSlot = null;
  effectQueue = [];
  scheduled = false;
  mountedRoot = { element };
  const tree = renderNode(element);
  mountedRoot = { element, tree };
  return tree;
}

/** Find the first host node whose text content contains `needle`. */
function findHostByText(tree, needle) {
  const hosts = flattenHosts(tree, []);
  for (const host of hosts) {
    const text = flattenText(host.rendered, []).join('');
    if (text.indexOf(needle) !== -1) return host;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG = {
  version: 1,
  elements: [
    {
      type: 'Dremu.DremuMainLane',
      shortName: 'MainLane',
      category: 'lane',
      color: '#38e8c4',
      timing: { start: 'generateTime', duration: 'keepTime', lane: null },
      fields: [
        { name: 'name', type: 'string', default: 'lane01' },
        { name: 'generateTime', type: 'number', default: 0 },
        { name: 'keepTime', type: 'number', default: 10 },
        { name: 'laneLines', type: 'array', default: [] },
      ],
    },
    {
      type: 'Dremu.DremuTap',
      shortName: 'Tap',
      category: 'note',
      color: '#22c55e',
      timing: { start: 'hitTime', duration: null, lane: 'laneName' },
      fields: [
        { name: 'laneName', type: 'string', default: '' },
        { name: 'hitTime', type: 'number', default: 0 },
        { name: 'leadTime', type: 'number', default: 0.6 },
        { name: 'position', type: 'VariableFloat', default: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: 0 } } },
      ],
    },
    {
      type: 'Dremu.DremuHold',
      shortName: 'Hold',
      category: 'hold',
      color: '#7c8cff',
      timing: { start: 'hitTime', duration: 'holdTime', lane: 'laneName' },
      fields: [
        { name: 'laneName', type: 'string', default: '' },
        { name: 'hitTime', type: 'number', default: 0 },
        { name: 'holdTime', type: 'number', default: 1 },
        { name: 'holdLine', type: 'curve', default: { t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 1, valueEnd: 1 } } },
      ],
    },
    {
      type: 'DeentyStoryboard.Image',
      shortName: 'Image',
      category: 'other',
      group: 'DeentyStoryboard',
      color: '#f472b6',
      timing: { start: 'startMoment', duration: 'keepTime', lane: null },
      fields: [
        { name: 'assetName', type: 'string', default: '' },
        { name: 'startMoment', type: 'number', default: 0 },
        { name: 'keepTime', type: 'number', default: 1 },
      ],
    },
  ],
  valueTypes: {},
  palettes: {},
};

const PROJECT = {
  dir: '/tmp/gorge-fixture',
  id: '/tmp/gorge-fixture',
  title: 'Fixture Song',
  form: 'Dremu',
  tempo: { bpm: 120, offset: 0 },
  duration: 40,
  audio: { name: 'Song.wav', file: '/tmp/gorge-fixture/Song.wav', duration: 12 },
  audioPeriods: [
    {
      id: 'a0',
      staffId: 'Song.g',
      method: 'GetSong',
      name: 'Song',
      assetType: 'GorgeFramework.WavAudioAsset',
      relativePath: 'Song.wav',
      file: '/tmp/gorge-fixture/Song.wav',
      offset: 0,
      duration: 12,
      sampleRate: 8000,
      channels: 1,
      format: 'wav',
      missing: false,
    },
  ],
  assets: { images: [], audio: ['Song.wav'] },
  warnings: ['样例警告'],
  staffs: [
    {
      id: 'DremuStaff.g',
      file: '/tmp/gorge-fixture/DremuStaff.g',
      kind: 'chart',
      form: 'Dremu',
      displayName: '谱表A',
      className: 'DremuStaff',
      periods: [
        {
          id: 'p0',
          method: 'Period',
          timeOffset: 0,
          minLength: 10,
          elements: [
            {
              id: 'p0:e0',
              type: 'Dremu.DremuMainLane',
              fields: { name: 'Main1', generateTime: 0, keepTime: 20 },
              start: 0,
              duration: 20,
              lane: null,
              category: 'lane',
            },
            {
              id: 'p0:e1',
              type: 'Dremu.DremuTap',
              fields: {
                laneName: 'Main1',
                hitTime: 2,
                leadTime: 0.6,
                position: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: -1 } },
              },
              start: 2,
              duration: null,
              lane: 'Main1',
              category: 'note',
            },
            {
              id: 'p0:e2',
              type: 'Dremu.DremuHold',
              fields: {
                laneName: 'Main1',
                hitTime: 6,
                holdTime: 2,
                holdLine: { t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 2, valueEnd: 1 } },
              },
              start: 6,
              duration: 2,
              lane: 'Main1',
              category: 'hold',
            },
          ],
        },
        {
          id: 'p1',
          method: 'Period1',
          timeOffset: 21.21053,
          minLength: null,
          elements: [
            {
              id: 'p1:e0',
              type: 'Dremu.DremuTap',
              fields: { laneName: 'Main1', hitTime: 0.5, leadTime: 0.6 },
              start: 21.71053,
              duration: null,
              lane: 'Main1',
              category: 'note',
            },
          ],
        },
      ],
    },
    {
      id: 'Song.g',
      file: '/tmp/gorge-fixture/Song.g',
      kind: 'audio',
      form: '',
      displayName: '音频',
      className: 'Song',
      periods: [],
      audioPeriods: [
        {
          id: 'a0',
          staffId: 'Song.g',
          method: 'GetSong',
          name: 'Song',
          assetType: 'GorgeFramework.WavAudioAsset',
          relativePath: 'Song.wav',
          file: '/tmp/gorge-fixture/Song.wav',
          offset: 0,
          duration: 12,
          sampleRate: 8000,
          channels: 1,
          format: 'wav',
          missing: false,
        },
      ],
    },
  ],
};

/**
 * Optional real-data mode: `GORGE_SMOKE_REAL=1 node tests/client-smoke.mjs`
 * loads the actual DremuTest project through dremu-model.js and renders the
 * page against the real catalog and wire state (read-only; no file is written).
 */
async function loadRealState() {
  const model = await import('../dremu-model.js');
  const project = model.loadProject('/Users/daxingyi/Music/DremuTest');
  const wire = model.projectToWire(project, { rev: 7 });
  return {
    ok: true,
    rev: 7,
    dirty: false,
    openPath: '/Users/daxingyi/Music/DremuTest',
    recent: ['/Users/daxingyi/Music/DremuTest'],
    project: wire.project,
    catalog: wire.catalog || model.CATALOG,
  };
}

/** 12 s 8 kHz mono click track (kick on beats, hat on offbeats) for BPM tests. */
function makeClickWav(bpm = 128, seconds = 12, sampleRate = 8000) {
  const frames = sampleRate * seconds;
  const pcm = Buffer.alloc(frames * 2);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let beat = 0; beat < seconds; beat += 60 / bpm) {
    const start = Math.round(beat * sampleRate);
    for (let i = 0; i < Math.min(frames - start, Math.round(0.12 * sampleRate)); i += 1) {
      const value = Math.sin((2 * Math.PI * 60 * i) / sampleRate) * Math.exp(-i / (0.03 * sampleRate)) * 0.9;
      pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), (start + i) * 2);
    }
    const hat = Math.round((beat + 30 / bpm) * sampleRate);
    for (let i = 0; i < Math.min(frames - hat, Math.round(0.03 * sampleRate)); i += 1) {
      const at = hat + i;
      const current = pcm.readInt16LE(at * 2) / 32767;
      const value = current + random() * Math.exp(-i / (0.008 * sampleRate)) * 0.35;
      pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), at * 2);
    }
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
const CLICK_WAV = makeClickWav();

/** fetch stub keyed by URL. */
let stateResponse = { ok: true, rev: 3, dirty: false, openPath: PROJECT.dir, recent: [PROJECT.dir], project: PROJECT, catalog: CATALOG };
if (process.env.GORGE_SMOKE_REAL === '1') {
  stateResponse = await loadRealState();
}
let projectsResponse = { ok: true, projectRoot: '/tmp', count: 1, projects: [{ dir: PROJECT.dir, title: PROJECT.title, staffs: 1 }] };
const calls = [];

const editBodies = [];
function mockFetch(url, options) {
  const target = String(url);
  calls.push(target);
  if (target.indexOf('/plugins/gorge-chart/edit') !== -1 && options && options.body) {
    try {
      editBodies.push(JSON.parse(options.body));
    } catch (error) {
      editBodies.push(null);
    }
  }
  if (target.indexOf('/plugins/gorge-chart/projects') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => projectsResponse });
  }
  if (target.indexOf('/plugins/gorge-chart/edit') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ rev: 4, dirty: true, changed: true }) });
  }
  if (target.indexOf('/plugins/gorge-chart/save') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, written: ['DremuStaff.g'], errors: [], rev: 5, dirty: false }) });
  }
  if (target.indexOf('/plugins/gorge-chart/file') !== -1) {
    const audioBuffer = target.indexOf('.wav') !== -1 ? CLICK_WAV : null;
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        if (!audioBuffer) return new ArrayBuffer(64);
        return audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength);
      },
      json: async () => ({}),
    });
  }
  if (target.indexOf('/plugins/gorge-chart/state') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => stateResponse });
  }
  if (target.indexOf('/plugins/gorge-chart/events') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
}

// ---------------------------------------------------------------------------
// Load the client bundle
// ---------------------------------------------------------------------------

installGlobals();
let captured = null;
window.__ModuleLoader__ = {
  load(entry) {
    captured = entry;
  },
};

const source = fs.readFileSync(clientPath, 'utf8');
const sandboxRequire = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};

// The bundle calls window.__ModuleLoader__.load({ id, factory }) at load time.
const evaluate = new Function('require', 'window', 'document', 'globalThis', source + '\n//# sourceURL=client.js');
evaluate(sandboxRequire, globalThis.window, globalThis.document, globalThis);

assert.ok(captured, 'client bundle did not call window.__ModuleLoader__.load');
assert.equal(captured.id, '@local/gorge-chart-studio', 'bundle id mismatch');
assert.equal(typeof captured.factory, 'function', 'factory missing');

const clientPlugin = captured.factory(sandboxRequire);
assert.equal(typeof clientPlugin.apply, 'function', 'client plugin has no apply');
assert.deepEqual(clientPlugin.inject, ['slots', 'locale'], 'client plugin inject list');

// ---- Audio clip model: multi-@Song clips + legacy single-audio fallback ----
{
  const audio = clientPlugin.__audio;
  assert.ok(audio && typeof audio.audioClipsOf === 'function', 'client exposes no __audio test helpers');
  assert.ok(typeof audio.clipActiveAt === 'function');
  const legacy = audio.audioClipsOf({ audio: { file: '/tmp/legacy.wav', name: 'Legacy', duration: 7, offset: 2.5 } });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].offset, 2.5);
  assert.equal(legacy[0].name, 'Legacy');
  const clipA = { id: 'a0', staffId: 'Song.g', file: '/tmp/a.wav', offset: 1, duration: 2 };
  const clipB = { id: 'a1', staffId: 'Song.g', file: '/tmp/b.wav', offset: 5, duration: 3 };
  const multi = audio.audioClipsOf({ staffs: [{ id: 'Song.g', kind: 'audio', audioPeriods: [clipA, clipB] }], audioPeriods: [clipA, clipB] });
  assert.equal(multi.length, 2, 'both @Song clips must reach the transport');
  assert.equal(audio.clipActiveAt(clipA, 0.999), false);
  assert.equal(audio.clipActiveAt(clipA, 1), true);
  assert.equal(audio.clipActiveAt(clipA, 2.999), true);
  assert.equal(audio.clipActiveAt(clipA, 3), false);
  assert.equal(audio.clipActiveAt(clipB, 4.5), false);
  assert.equal(audio.clipActiveAt(clipA, 4.5), false, 'the two clips leave a gap at 3…5 s');
  assert.equal(audio.clipActiveAt(clipB, 5), true);

  // Spectrogram: a steady 440 Hz tone must peak in the matching log band.
  assert.equal(typeof audio.spectrumFromSamples, 'function', 'spectrum computation is not exposed');
  const spectrum = audio.spectrumFromSamples(
    (frame) => Math.sin((2 * Math.PI * 440 * frame) / 8000),
    8000,
    8000,
  );
  assert.ok(spectrum, 'spectrum computation returned null');
  assert.equal(spectrum.columns, 360);
  assert.equal(spectrum.bands, 128);
  assert.equal(spectrum.data.length, spectrum.columns * spectrum.bands);
  const column = 180;
  let peakBand = -1;
  let peakValue = -1;
  for (let band = 0; band < spectrum.bands; band += 1) {
    const value = spectrum.data[column * spectrum.bands + band];
    if (value > peakValue) {
      peakValue = value;
      peakBand = band;
    }
  }
  assert.ok(peakValue > 100, 'spectrum has no strong band for a full-scale sine');
  const bandHz = spectrum.minHz * Math.pow(spectrum.maxHz / spectrum.minHz, (peakBand + 0.5) / spectrum.bands);
  assert.ok(Math.abs(bandHz - 440) < 100, 'spectrum peak band is at ' + bandHz.toFixed(1) + ' Hz, expected ~440 Hz');
  const silence = audio.spectrumFromSamples(() => 0, 4000, 8000);
  assert.ok(silence && silence.data.every((value) => value === 0), 'silent audio must produce an empty spectrum');

  // WAV fast path: parse a real PCM buffer into peaks + spectrogram.
  const sampleRate = 8000;
  const frames = sampleRate;
  const pcm = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 14000), frame * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  const wavAnalysis = audio.wavPeaks(wavBuffer, 128);
  assert.ok(wavAnalysis, 'wavPeaks rejected a valid PCM WAV');
  assert.ok(Math.abs(wavAnalysis.duration - 1) < 0.01, 'WAV duration: ' + wavAnalysis.duration);
  assert.equal(wavAnalysis.channels, 1);
  assert.equal(wavAnalysis.peaks.length, 128);
  assert.ok(wavAnalysis.peaks.some((peak) => peak > 0.3), 'WAV peaks are silent');
  assert.ok(wavAnalysis.spectrum && wavAnalysis.spectrum.data.length === wavAnalysis.spectrum.columns * wavAnalysis.spectrum.bands, 'WAV analysis has no spectrum');

  // BPM detection: a kick+hat click track at 128 BPM must be recognized.
  const bpmRate = 8000;
  const bpmSeconds = 12;
  const bpmFrames = bpmRate * bpmSeconds;
  const bpmSamples = new Float32Array(bpmFrames);
  let bpmSeed = 7;
  const bpmRand = () => {
    bpmSeed = (bpmSeed * 1664525 + 1013904223) % 4294967296;
    return (bpmSeed / 4294967296) * 2 - 1;
  };
  const clickTrack = (bpm) => {
    bpmSamples.fill(0);
    const period = 60 / bpm;
    for (let beat = 0; beat < bpmSeconds; beat += period) {
      const start = Math.round(beat * bpmRate);
      for (let i = 0; i < Math.min(bpmFrames - start, Math.round(0.12 * bpmRate)); i += 1) {
        bpmSamples[start + i] += Math.sin((2 * Math.PI * 60 * i) / bpmRate) * Math.exp(-i / (0.03 * bpmRate)) * 0.9;
      }
      const hat = Math.round((beat + period / 2) * bpmRate);
      for (let i = 0; i < Math.min(bpmFrames - hat, Math.round(0.03 * bpmRate)); i += 1) {
        bpmSamples[hat + i] += bpmRand() * Math.exp(-i / (0.008 * bpmRate)) * 0.35;
      }
    }
  };
  clickTrack(128);
  const bpmSpectrum = audio.spectrumFromSamples((frame) => bpmSamples[frame], bpmFrames, bpmRate);
  assert.ok(bpmSpectrum, 'click track produced no spectrum');
  const detected = audio.detectBpmFromSpectrum(bpmSpectrum, bpmSeconds);
  assert.ok(detected, 'BPM detector returned null');
  assert.ok(Math.abs(detected.bpm - 128) <= 1, 'BPM detector returned ' + detected.bpm + ', expected ~128');
  assert.ok(detected.confidence > 0.3, 'BPM confidence is too low: ' + detected.confidence);
  assert.equal(audio.detectBpmFromSpectrum(null, 12), null);
  assert.equal(audio.detectBpmFromSpectrum(bpmSpectrum, 1), null, 'clips shorter than 3 s must not be analyzed');
}

// ---------------------------------------------------------------------------
// Mount the page
// ---------------------------------------------------------------------------

const t = (key) => key;
const pageElement = React.createElement(
  // Resolve the page through the slot registration path: capture it from apply.
  (() => {
    const registrations = [];
    const ctx = {
      locale: {
        register: () => () => undefined,
        bind: () => t,
      },
      effect: (factory) => {
        const cleanup = factory();
        return typeof cleanup === 'function' ? cleanup : () => undefined;
      },
      slots: {
        inject: (name, factory) => {
          factory();
        },
        register: (options, component) => {
          registrations.push({ options, component });
          return () => undefined;
        },
      },
    };
    clientPlugin.apply(ctx);
    const page = registrations.find((item) => item.options.name === 'main');
    assert.ok(page, 'no main slot registration');
    assert.equal(page.options.key, 'gorge-chart', 'main panel key');
    const icon = registrations.find((item) => item.options.name === 'sidebar.panellist');
    assert.ok(icon, 'no sidebar.panellist registration');
    assert.equal(icon.options.id, 'gorge-chart', 'sidebar panel id');
    return page.component;
  })(),
  { t },
);

let tree = mount(pageElement);
tree = await settle();

const text = flattenText(tree, []).join(' ');
assert.ok(text.length > 0, 'page rendered no text');
assert.ok(text.includes('openProject') || text.includes('title'), 'page chrome missing');

// Expected values come from whichever project state is under test.
const isRealMode = process.env.GORGE_SMOKE_REAL === '1';
const expectedTitle = stateResponse.project.title;
const expectedStaff = stateResponse.project.staffs.find((staff) => staff.kind === 'chart');
const expectedLane = (() => {
  for (const staff of stateResponse.project.staffs) {
    for (const period of staff.periods || []) {
      for (const element of period.elements || []) {
        if (element.category === 'lane' && element.fields && typeof element.fields.name === 'string') return element.fields.name;
      }
    }
  }
  return null;
})();
assert.ok(text.includes(expectedTitle), 'project title missing: ' + expectedTitle);
const autoBpmButton = findHost(tree, (host) => host.props && String(host.className).includes('dgc-autoBpm'));
assert.ok(autoBpmButton, 'inspector has no auto-BPM button');
assert.equal(autoBpmButton.props.disabled, false, 'auto-BPM is still disabled after audio analysis');
assert.ok(expectedStaff && text.includes(expectedStaff.displayName), 'staff display name missing');
assert.ok(expectedLane && text.includes(expectedLane), 'lane name missing: ' + expectedLane);
if (!isRealMode) assert.ok(text.includes('Fixture Song'));

const hosts = flattenHosts(tree, []);
const canvases = hosts.filter((host) => host.tagName === 'CANVAS');
assert.ok(canvases.length >= 1, 'timeline canvas missing');
assert.ok(canvases[0].getContext('2d'), 'timeline canvas has no 2d context');

// ---- Canvas text layout: nothing may overlap or spill out of the gutter ----
// Each canvas 2D context keeps only its most recent frame (a paint clears
// first), so every context is checked on its own.
function assertCanvasTextLayout() {
  const GUTTER_W = 148;
  let totalRuns = 0;
  let checkedFrames = 0;
  for (const context of canvasContexts) {
    const frame = context.drawn.slice();
    if (frame.length < 5) continue;
    checkedFrames += 1;
    totalRuns += frame.length;
    // 1. Text drawn in the left gutter must stay inside that column.
    for (const item of frame) {
      if (item.x >= GUTTER_W) continue;
      assert.ok(item.x >= 0, 'gutter text starts at a negative x: ' + JSON.stringify(item));
      assert.ok(
        item.x + item.width <= GUTTER_W + 1,
        'gutter text spills over its column: ' + JSON.stringify(item),
      );
    }
    // 1b. Text painted inside a bar/tooltip rect must fit inside that rect
    //     (a lane type label like "DremuMainLane" is much wider than the bar).
    const rects = context.rects.filter((rect) => rect.x >= GUTTER_W - 1 && rect.w >= 6 && rect.h >= 10 && rect.h <= 30);
    for (const item of frame) {
      if (item.x < GUTTER_W) continue;
      const container = rects.find(
        (rect) => item.y >= rect.y && item.y <= rect.y + rect.h && item.x >= rect.x - 2 && item.x <= rect.x + rect.w + 2,
      );
      if (!container) continue;
      assert.ok(
        item.x + item.width <= container.x + container.w + 1,
        'text overflows its bar: ' + JSON.stringify({ text: item.text, textRight: item.x + item.width, barRight: container.x + container.w }),
      );
    }

    // 2. Text on the same baseline must not overlap horizontally.
    const bands = new Map();
    for (const item of frame) {
      const key = Math.round(item.y);
      if (!bands.has(key)) bands.set(key, []);
      bands.get(key).push(item);
    }
    for (const [y, items] of bands) {
      const sorted = items.slice().sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        const previous = sorted[i - 1];
        const current = sorted[i];
        if (previous.text === current.text) continue;
        assert.ok(
          current.x >= previous.x + previous.width - 1.5,
          'canvas text overlaps on the same line (y=' + y + '): ' +
            JSON.stringify({ left: previous.text, right: current.text, gap: current.x - (previous.x + previous.width) }),
        );
      }
    }
  }
  assert.ok(checkedFrames > 0, 'no painted canvas frame was recorded');
  assert.ok(totalRuns > 20, 'canvas painted almost no text (' + totalRuns + ' runs)');
  return totalRuns;
}

// The group header must actually be part of the checked frames, and its counts
// must live in the time column (the old layout drew them over the staff name).
{
  const frames = canvasContexts.map((context) => context.drawn).filter((frame) => frame.length > 5);
  const headerFrames = frames.filter((frame) => frame.some((item) => item.text === expectedStaff.displayName));
  assert.ok(headerFrames.length > 0, 'no painted frame contains the staff (谱表) header title');
  const countsRun = headerFrames.flat().find((item) => /^lanes \d+/.test(item.text) || /^轨道 \d+/.test(item.text));
  assert.ok(countsRun, 'staff header did not paint its lane/note counts');
  assert.ok(countsRun.x >= 148, 'staff header counts are drawn in the gutter (would overlap the name)');
}

const components = flattenComponents(tree, []).map((component) => component.name);
const canvasTextRuns = assertCanvasTextLayout();
for (const expected of ['ChartStudioPage', 'LeftPane', 'TimelineCanvas', 'InspectorPane', 'TransportBar']) {
  assert.ok(components.includes(expected), 'component not rendered: ' + expected);
}

// The session fetched the Host state once.
assert.ok(calls.some((url) => url.indexOf('/plugins/gorge-chart/state') !== -1), 'state endpoint not called');

// ---------------------------------------------------------------------------
// Inspector + curve dialog with a real selection
// ---------------------------------------------------------------------------

/** First host node matching a predicate. */
function findHost(tree, predicate) {
  const hosts = flattenHosts(tree, []);
  for (const host of hosts) {
    try {
      if (predicate(host)) return host;
    } catch (error) {
      /* ignore predicate errors on stub nodes */
    }
  }
  return null;
}

/** First host node that has an onClick handler and whose text contains `needle`. */
function findClickableByText(tree, needle) {
  return findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').indexOf(needle) !== -1;
  });
}

// 1. Select the Hold element from the element list (the corpus and the
// fixture both contain DremuHold elements).
const holdRow = findClickableByText(tree, 'DremuHold');
assert.ok(holdRow, 'DremuHold row not found in the element list');
holdRow.props.onClick({ target: holdRow, stopPropagation() {}, preventDefault() {}, shiftKey: false, metaKey: false, ctrlKey: false });
tree = await settle();

const inspectorText = flattenText(tree, []).join(' ');
assert.ok(inspectorText.includes('holdTime') || inspectorText.includes('长条') || inspectorText.includes('时长'), 'inspector did not render the hold fields');
assert.ok(inspectorText.includes('laneName') || inspectorText.includes('轨道'), 'inspector did not render the lane field');
assert.ok(/[:]p\d+:e\d+|p0:e/.test(inspectorText) || inspectorText.includes('play'), 'inspector did not show the element id');

// 2. Open the curve dialog from the hold's curve field.
const curveButton = findHost(tree, (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'curveEditor');
assert.ok(curveButton, 'curve editor button not found for the curve field');
curveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: curveButton });
tree = await settle();

assert.ok(flattenText(tree, []).join(' ').includes('curveEditor'), 'curve dialog did not open');
const dialogCanvases = flattenHosts(tree, []).filter((host) => host.tagName === 'CANVAS');
assert.ok(dialogCanvases.length >= 2, 'curve dialog did not render its plot canvas');
assert.ok(flattenHosts(tree, []).some((host) => String(host.className).includes('dgc-modalBackdrop')), 'curve dialog backdrop missing');
// The numeric tree must expose the LinearCurve fields.
const dialogText = flattenText(tree, []).join(' ');
for (const field of ['timeStart', 'valueStart', 'timeEnd', 'valueEnd']) {
  assert.ok(dialogText.includes(field), 'curve dialog numeric tree missing ' + field);
}

// 3. Apply the dialog: one edit op must be queued to the Host.
const editCallsBefore = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
const applyButton = findHost(tree, (host) => {
  if (!host.props || typeof host.props.onClick !== 'function') return false;
  const label = flattenText(host.rendered, []).join(' ');
  return label.trim() === 'apply';
});
assert.ok(applyButton, 'curve dialog apply button not found');
applyButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: applyButton });
tree = await settle();
await new Promise((resolve) => setTimeout(resolve, 5));

const editCallsAfter = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
assert.ok(editCallsAfter > editCallsBefore, 'applying the curve did not POST an edit');

// (Undo/redo are exercised by the timeline drag below, through the real buttons.)

// 5. Save button must POST /save.
const saveButton = findHost(tree, (host) => {
  if (!host.props || typeof host.props.onClick !== 'function') return false;
  return flattenText(host.rendered, []).join('').indexOf('save') !== -1 && String(host.className).includes('is-primary');
});
if (saveButton) {
  saveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: saveButton });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(calls.some((url) => url.indexOf('/plugins/gorge-chart/save') !== -1), 'save button did not POST /save');
}

// ---------------------------------------------------------------------------
// Timeline direct manipulation: drag a note, then undo it.
//
// The coordinates below are derived from the fixture chart (first lane row,
// tap at 2 s), so this block runs in fixture mode only; real-catalog mode
// verifies rendering and the data path instead.
// ---------------------------------------------------------------------------

if (!isRealMode) {
  // ---------------------------------------------------------------------------
  // Timeline direct manipulation: drag a note, then undo it.
  // ---------------------------------------------------------------------------

  /** Dispatch a synthetic pointer event at canvas coordinates. */
  function pointer(host, kind, x, y, extra) {
    const event = Object.assign(
      {
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        pointerId: 1,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        preventDefault() {},
        stopPropagation() {},
        target: host,
        currentTarget: host,
      },
      extra || {},
    );
    const handler = host.props['on' + kind];
    assert.equal(typeof handler, 'function', 'no ' + kind + ' handler on the canvas');
    handler(event);
  }

  // The harness re-creates host nodes on every render, so always resolve the
  // canvas (and therefore its fresh props/closure) from the current tree.
  function timelineCanvas() {
    const host = findHost(tree, (node) => node.tagName === 'CANVAS' && node.props && typeof node.props.onPointerDown === 'function');
    assert.ok(host, 'timeline canvas with pointer handlers not found');
    return host;
  }
  assert.ok(timelineCanvas(), 'timeline canvas missing');

  // A lane element bar must track the pointer while it is dragged, exactly
  // like notes do, instead of sitting still and only jumping on release.
  // Grab the lane bar at 12 s (clear of the tap at 2 s and the hold at 6–8 s)
  // and move it one second right: 46 px at pps = 46 → its left edge must move
  // from x = 148 to x = 194 inside the same pointer-move frame.
  {
    pointer(timelineCanvas(), 'PointerDown', 700, 112);
    // Resolve the canvas again for the move: the harness rebuilds host nodes on
    // render, and only the node current at paint time records the preview frame.
    const laneCanvas = timelineCanvas();
    pointer(laneCanvas, 'PointerMove', 746, 112);
    const laneContext = laneCanvas.getContext('2d');
    const laneBar = laneContext.rects.find(
      (rect) =>
        rect.kind === 'fillRect' &&
        rect.w > 100 &&
        Math.abs(rect.y - 98) < 1 &&
        Math.abs(rect.x - (148 + 46)) < 2,
    );
    assert.ok(
      laneBar,
      'lane bar did not follow the pointer during a drag; wide rects in the last frame: ' +
        JSON.stringify(laneContext.rects.filter((rect) => rect.w > 100)),
    );
    pointer(timelineCanvas(), 'PointerCancel', 746, 112);
  }

  // Geometry: GUTTER_W = 148, view starts at t0 = 0 with pps = 46, header
  // (ruler 26 + waveform 44) = 70. Row 0 is the staff (谱表) group header
  // (25 px) and row 1 is the first lane, whose first note starts at 2 s:
  //   x = 148 + 2*46 = 240, y = 70 + 25 + 17 = 112.
  const editBodiesBefore = editBodies.length;
  pointer(timelineCanvas(), 'PointerDown', 240, 112);
  pointer(timelineCanvas(), 'PointerMove', 240 + 46, 112);
  pointer(timelineCanvas(), 'PointerUp', 240 + 46, 112);
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(editBodies.length > editBodiesBefore, 'dragging a note did not POST an edit');
  const dragBatch = editBodies[editBodies.length - 1];
  assert.ok(dragBatch && Array.isArray(dragBatch.ops) && dragBatch.ops.length > 0, 'drag produced an empty op batch');
  const patch = dragBatch.ops.find((op) => op.op === 'patch');
  assert.ok(patch, 'drag did not produce a patch op');
  assert.equal(patch.path[0], 'hitTime', 'drag must patch hitTime for a tap, got ' + JSON.stringify(patch.path));
  assert.ok(Math.abs(patch.value - 3) < 0.2, 'drag +1s should move hitTime from 2 to ~3, got ' + patch.value);
  assert.ok(Number.isFinite(dragBatch.baseRev), 'edit batch carries no baseRev');

  // Undo through the header button (label "undo"): it must POST a real inverse.
  const undoButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    const label = flattenText(host.rendered, []).join('').trim();
    return label === 'undo';
  });
  assert.ok(undoButton, 'undo button not found');
  const editsBeforeUndo = editBodies.length;
  undoButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: undoButton });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeUndo, 'undo did not POST an inverse edit');
  const undoBatch = editBodies[editBodies.length - 1];
  assert.ok(undoBatch && undoBatch.ops.length > 0, 'undo POSTed an empty op batch (inverse was not recorded)');
  assert.ok(
    undoBatch.ops.every((op) => op.op === 'patch' && op.path[0] === 'hitTime' && Math.abs(op.value - 2) < 0.2),
    'undo batch does not restore hitTime = 2: ' + JSON.stringify(undoBatch.ops),
  );

  // Redo must restore the dragged value.
  const redoButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join('').trim() === 'redo';
  });
  assert.ok(redoButton, 'redo button not found');
  const editsBeforeRedo = editBodies.length;
  redoButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: redoButton });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeRedo, 'redo did not POST an edit');
  const redoBatch = editBodies[editBodies.length - 1];
  assert.ok(redoBatch.ops.length > 0 && Math.abs(redoBatch.ops[0].value - 3) < 0.2, 'redo did not restore the dragged hitTime');

  // Place a new element with the Tap tool: double-click at 5 s on row 0.
  const tapToolButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join('').trim() === 'toolTap';
  });
  assert.ok(tapToolButton, 'tap tool button not found');
  tapToolButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: tapToolButton });
  tree = await settle();
  const editsBeforeAdd = editBodies.length;
  const x5 = 148 + 5 * 46;
  pointer(timelineCanvas(), 'DoubleClick', x5, 112);
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeAdd, 'placing a note did not POST an add op');
  const addBatch = editBodies[editBodies.length - 1];
  const addOp = addBatch.ops.find((op) => op.op === 'add');
  assert.ok(addOp, 'placement did not produce an add op: ' + JSON.stringify(addBatch.ops));
  assert.equal(addOp.element.type, 'Dremu.DremuTap');
  assert.equal(addOp.element.fields.laneName, 'Main1', 'placed note must join the row lane');
  assert.ok(Math.abs(addOp.element.fields.hitTime - 5) < 0.2, 'placed note hitTime should be ~5, got ' + addOp.element.fields.hitTime);
  assert.ok(addOp.periodId, 'add op carries no periodId');

  // -------------------------------------------------------------------------
  // Left pane: create a staff from the header "+", then add an element to it.
  // -------------------------------------------------------------------------
  const addStaffButton = findHost(
    tree,
    (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'addStaff',
  );
  assert.ok(addStaffButton, 'staff section has no add button');
  addStaffButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: addStaffButton, currentTarget: addStaffButton });
  tree = await settle();
  assert.ok(flattenText(tree, []).join(' ').includes('newStaff'), 'new staff dialog did not open');

  const createStaffButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return String(host.className).indexOf('dgc-btn') !== -1 && flattenText(host.rendered, []).join('').trim() === 'create';
  });
  assert.ok(createStaffButton, 'new staff dialog has no create button');
  createStaffButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: createStaffButton });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const staffBatch = editBodies[editBodies.length - 1];
  const staffOp = staffBatch && staffBatch.ops.find((op) => op.op === 'addStaff');
  assert.ok(staffOp, 'adding a staff did not POST an addStaff op');
  assert.equal(staffOp.kind, 'chart');
  assert.equal(staffOp.form, 'Dremu');
  assert.equal(staffOp.className, 'Staff');
  assert.equal(staffOp.fileName, 'Staff.g');
  assert.equal(staffOp.displayName, 'defaultStaffName');
  assert.ok(flattenText(tree, []).join(' ').includes('defaultStaffName'), 'the new staff is not listed in the left pane');

  const addElementButton = findHost(
    tree,
    (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'addElement',
  );
  assert.ok(addElementButton, 'element section has no add button');
  addElementButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: addElementButton, currentTarget: addElementButton });
  tree = await settle();
  const paletteRow = findHost(
    tree,
    (host) =>
      host.props &&
      typeof host.props.onClick === 'function' &&
      String(host.className).indexOf('dgc-paletteRow') !== -1 &&
      flattenText(host.rendered, []).join(' ').indexOf('Tap') !== -1,
  );
  assert.ok(paletteRow, 'element palette row for Tap not found');
  paletteRow.props.onClick({ preventDefault() {}, stopPropagation() {}, target: paletteRow });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const paletteBatch = editBodies[editBodies.length - 1];
  const paletteOp = paletteBatch && paletteBatch.ops.find((op) => op.op === 'add');
  assert.ok(paletteOp, 'picking an element type did not POST an add op');
  assert.equal(paletteOp.staffId, 'Staff.g');
  assert.equal(paletteOp.periodId, 'p0');
  assert.equal(paletteOp.element.type, 'Dremu.DremuTap');
  assert.ok(Math.abs(paletteOp.element.fields.hitTime) < 0.2, 'palette add must land at the playhead (0 s)');
  assert.ok(flattenText(tree, []).join(' ').includes('DremuTap'), 'the added element is not listed');

  // Storyboard staff: the palette must switch to DeentyStoryboard.Image only.
  const addStaffButton2 = findHost(
    tree,
    (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'addStaff',
  );
  addStaffButton2.props.onClick({ preventDefault() {}, stopPropagation() {}, target: addStaffButton2, currentTarget: addStaffButton2 });
  tree = await settle();
  const storyboardKind = findHost(
    tree,
    (host) =>
      host.props &&
      typeof host.props.onClick === 'function' &&
      String(host.className).indexOf('dgc-kindCard') !== -1 &&
      flattenText(host.rendered, []).join(' ').indexOf('staffKindStoryboardOption') !== -1,
  );
  assert.ok(storyboardKind, 'storyboard kind card not found');
  storyboardKind.props.onClick({ preventDefault() {}, stopPropagation() {}, target: storyboardKind });
  tree = await settle();
  const createStoryboard = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return String(host.className).indexOf('dgc-btn') !== -1 && flattenText(host.rendered, []).join('').trim() === 'create';
  });
  createStoryboard.props.onClick({ preventDefault() {}, stopPropagation() {}, target: createStoryboard });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const storyboardStaffOp = editBodies[editBodies.length - 1].ops.find((op) => op.op === 'addStaff');
  assert.ok(storyboardStaffOp, 'storyboard staff did not POST an addStaff op');
  assert.equal(storyboardStaffOp.kind, 'storyboard');
  assert.equal(storyboardStaffOp.form, 'DeentyStoryboard');
  assert.equal(storyboardStaffOp.className, 'Storyboard');
  assert.equal(storyboardStaffOp.fileName, 'Storyboard.g');
  assert.equal(storyboardStaffOp.displayName, 'defaultStoryboardName');

  const addImageButton = findHost(
    tree,
    (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'addElement',
  );
  addImageButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: addImageButton, currentTarget: addImageButton });
  tree = await settle();
  const storyboardRows = flattenHosts(tree, []).filter((host) => String(host.className).indexOf('dgc-paletteRow') !== -1);
  assert.equal(storyboardRows.length, 1, 'storyboard palette must list exactly one element type');
  assert.ok(flattenText(storyboardRows[0].rendered, []).join(' ').includes('Image'), 'storyboard palette is missing Image');
  assert.ok(!flattenText(storyboardRows[0].rendered, []).join(' ').includes('Tap'), 'storyboard palette must not offer chart notes');
  storyboardRows[0].props.onClick({ preventDefault() {}, stopPropagation() {}, target: storyboardRows[0] });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const imageOp = editBodies[editBodies.length - 1].ops.find((op) => op.op === 'add');
  assert.ok(imageOp, 'picking Image did not POST an add op');
  assert.equal(imageOp.staffId, 'Storyboard.g');
  assert.equal(imageOp.element.type, 'DeentyStoryboard.Image');
  assert.ok(Math.abs(imageOp.element.fields.startMoment) < 0.2, 'Image must land at the playhead');

  // -------------------------------------------------------------------------
  // Staff right-click menu: rename the alias, then delete a staff.
  // -------------------------------------------------------------------------
  const rightClickStaffRow = (row) =>
    row.props.onContextMenu({
      preventDefault() {},
      stopPropagation() {},
      clientX: 140,
      clientY: 96,
      target: row,
      currentTarget: row,
    });

  // 1. Rename the alias of the chart staff (谱表A).
  const chartStaffRow = findHost(
    tree,
    (host) =>
      host.props &&
      typeof host.props.onContextMenu === 'function' &&
      flattenText(host.rendered, []).join(' ').indexOf('谱表A') !== -1,
  );
  assert.ok(chartStaffRow, 'staff rows have no context menu handler');
  rightClickStaffRow(chartStaffRow);
  tree = await settle();
  const contextMenu = findHost(tree, (host) => host.props && host.props.role === 'menu');
  assert.ok(contextMenu, 'right-clicking a staff did not open the context menu');
  const renameItem = findHost(
    contextMenu.rendered,
    (host) => host.props && typeof host.props.onClick === 'function' && flattenText(host.rendered, []).join(' ').indexOf('renameStaff') !== -1,
  );
  assert.ok(renameItem, 'context menu has no rename item');
  renameItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: renameItem });
  tree = await settle();

  const aliasInput = findHost(tree, (host) => host.tagName === 'INPUT' && host.props && host.props.autoFocus === true);
  assert.ok(aliasInput, 'rename dialog has no alias input');
  aliasInput.props.onChange({ target: { value: '新别名' } });
  tree = await settle();
  const editsBeforeRename = editBodies.length;
  const applyAlias = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return String(host.className).indexOf('is-primary') !== -1 && flattenText(host.rendered, []).join('').trim() === 'apply';
  });
  assert.ok(applyAlias, 'rename dialog has no apply button');
  applyAlias.props.onClick({ preventDefault() {}, stopPropagation() {}, target: applyAlias });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeRename, 'renaming a staff did not POST an edit');
  const renameOp = editBodies[editBodies.length - 1].ops.find((op) => op.op === 'setStaffName');
  assert.ok(renameOp, 'rename did not emit a setStaffName op');
  assert.equal(renameOp.staffId, 'DremuStaff.g');
  assert.equal(renameOp.displayName, '新别名');
  assert.ok(flattenText(tree, []).join(' ').indexOf('新别名') !== -1, 'the renamed staff alias is not listed');

  // 2. Delete a staff through the same menu (permanent, confirmed first).
  const staffRowToDelete = findHost(
    tree,
    (host) =>
      host.props &&
      typeof host.props.onContextMenu === 'function' &&
      flattenText(host.rendered, []).join(' ').indexOf('defaultStaffName') !== -1,
  );
  assert.ok(staffRowToDelete, 'the created staff row was not found');
  rightClickStaffRow(staffRowToDelete);
  tree = await settle();
  const deleteMenu = findHost(tree, (host) => host.props && host.props.role === 'menu');
  assert.ok(deleteMenu, 'context menu did not open for deletion');
  const deleteItem = findHost(
    deleteMenu.rendered,
    (host) => host.props && typeof host.props.onClick === 'function' && flattenText(host.rendered, []).join(' ').indexOf('deleteStaff') !== -1,
  );
  assert.ok(deleteItem, 'context menu has no delete item');
  deleteItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: deleteItem });
  tree = await settle();
  assert.ok(flattenText(tree, []).join(' ').indexOf('deleteStaffWarning') !== -1, 'delete confirmation did not open');
  const confirmDelete = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    const className = String(host.className);
    return className.indexOf('dgc-btn') !== -1 && className.indexOf('is-danger') !== -1 && flattenText(host.rendered, []).join('').trim() === 'delete';
  });
  assert.ok(confirmDelete, 'delete confirmation has no delete button');
  const editsBeforeDelete = editBodies.length;
  confirmDelete.props.onClick({ preventDefault() {}, stopPropagation() {}, target: confirmDelete });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeDelete, 'deleting a staff did not POST an edit');
  const removeOp = editBodies[editBodies.length - 1].ops.find((op) => op.op === 'removeStaff');
  assert.ok(removeOp, 'delete did not emit a removeStaff op');
  assert.equal(removeOp.staffId, 'Staff.g');
  assert.equal(removeOp.deleteFile, true, 'the Host must delete the .g file');
  const stillListed = findHost(
    tree,
    (host) =>
      host.props &&
      typeof host.props.onContextMenu === 'function' &&
      flattenText(host.rendered, []).join(' ').indexOf('defaultStaffName') !== -1,
  );
  assert.equal(stillListed, null, 'the deleted staff is still listed');

  // -------------------------------------------------------------------------
  // Audio periods (乐段): add one from the audio staff row, then drag its clip.
  // -------------------------------------------------------------------------
  const audioAddButton = findHost(
    tree,
    (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'addAudioPeriod',
  );
  assert.ok(audioAddButton, 'audio staff row has no add-audio-period button');
  audioAddButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: audioAddButton, currentTarget: audioAddButton });
  tree = await settle();
  assert.ok(flattenText(tree, []).join(' ').indexOf('newAudioPeriod') !== -1, 'audio period dialog did not open');
  const createAudioButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return String(host.className).indexOf('dgc-btn') !== -1 && String(host.className).indexOf('is-primary') !== -1 && flattenText(host.rendered, []).join('').trim() === 'create';
  });
  assert.ok(createAudioButton, 'audio period dialog has no create button');
  const editsBeforeAudio = editBodies.length;
  createAudioButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: createAudioButton });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeAudio, 'adding an audio period did not POST an edit');
  const audioBatch = editBodies[editBodies.length - 1];
  const audioOp = audioBatch && audioBatch.ops.find((op) => op.op === 'addAudioPeriod');
  assert.ok(audioOp, 'adding an audio period did not emit an addAudioPeriod op');
  assert.equal(audioOp.staffId, 'Song.g');
  assert.equal(audioOp.file, 'Song.wav');
  assert.ok(Math.abs(audioOp.timeOffset) < 0.2, 'the new clip starts at the playhead');

  // Grab the existing clip's bar in its timeline row and drag it ~2 s later.
  const audioRowY = 70 + 25 + 34 + 25 + 17;
  const editsBeforeAudioDrag = editBodies.length;
  pointer(timelineCanvas(), 'PointerDown', 160, audioRowY);
  pointer(timelineCanvas(), 'PointerMove', 252, audioRowY);
  pointer(timelineCanvas(), 'PointerUp', 252, audioRowY);
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(editBodies.length > editsBeforeAudioDrag, 'dragging an audio clip did not POST an edit');
  const audioDragBatch = editBodies[editBodies.length - 1];
  const audioDragOp = audioDragBatch && audioDragBatch.ops.find((op) => op.op === 'patchAudioPeriod');
  assert.ok(audioDragOp, 'dragging the clip did not emit a patchAudioPeriod op');
  assert.equal(audioDragOp.staffId, 'Song.g');
  assert.ok(audioDragOp.fields.timeOffset > 1 && audioDragOp.fields.timeOffset < 4, 'dragged clip offset: ' + audioDragOp.fields.timeOffset);

  // Right-click the audio strip -> switch the view to the spectrum.
  pointer(timelineCanvas(), 'ContextMenu', 300, 50);
  tree = await settle();
  const audioViewMenu = findHost(
    tree,
    (host) => host.props && host.props.role === 'menu' && flattenText(host.rendered, []).join(' ').indexOf('waveViewTitle') !== -1,
  );
  assert.ok(audioViewMenu, 'right-clicking the waveform did not open the audio view menu');
  const spectrumItem = findHost(
    audioViewMenu.rendered,
    (host) => host.props && host.props.role === 'menuitemradio' && flattenText(host.rendered, []).join(' ').indexOf('waveViewSpectrum') !== -1,
  );
  assert.ok(spectrumItem, 'audio view menu has no spectrum item');
  spectrumItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: spectrumItem });
  tree = await settle();
  pointer(timelineCanvas(), 'ContextMenu', 300, 50);
  tree = await settle();
  const audioViewMenu2 = findHost(
    tree,
    (host) => host.props && host.props.role === 'menu' && flattenText(host.rendered, []).join(' ').indexOf('waveViewTitle') !== -1,
  );
  assert.ok(audioViewMenu2, 'audio view menu did not reopen');
  const spectrumItem2 = findHost(
    audioViewMenu2.rendered,
    (host) => host.props && host.props.role === 'menuitemradio' && flattenText(host.rendered, []).join(' ').indexOf('waveViewSpectrum') !== -1,
  );
  assert.equal(spectrumItem2.props['aria-checked'], true, 'spectrum mode is not marked active');
  const waveItem2 = findHost(
    audioViewMenu2.rendered,
    (host) => host.props && host.props.role === 'menuitemradio' && flattenText(host.rendered, []).join(' ').indexOf('waveViewWaveform') !== -1,
  );
  waveItem2.props.onClick({ preventDefault() {}, stopPropagation() {}, target: waveItem2 });
  tree = await settle();

  // Auto BPM last: it changes the project tempo, and the drag geometry above
  // assumes the fixture's original 120 BPM grid.
  const editsBeforeBpm = editBodies.length;
  autoBpmButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: autoBpmButton });
  await new Promise((resolve) => setTimeout(resolve, 80));
  tree = await settle();
  assert.ok(editBodies.length > editsBeforeBpm, 'auto-BPM did not POST an edit');
  const bpmBatch = editBodies[editBodies.length - 1];
  const bpmOp = bpmBatch && bpmBatch.ops.find((op) => op.op === 'setMeta' && op.tempo && Number.isFinite(op.tempo.bpm));
  assert.ok(bpmOp, 'auto-BPM did not emit setMeta.tempo: ' + JSON.stringify(bpmBatch));
  assert.ok(Math.abs(bpmOp.tempo.bpm - 128) <= 1, 'auto-BPM set ' + bpmOp.tempo.bpm + ', expected ~128');
  assert.ok(flattenText(tree, []).join(' ').indexOf('bpmDetected') !== -1, 'auto-BPM notice is missing');

}
else {
  console.log('client-smoke: real-catalog mode — rendering verified, interaction geometry skipped.');
}

// ---------------------------------------------------------------------------
// Autoplay playback preview
//
// The preview lives entirely in the browser half of the plugin: the factory
// object exposes __playback with the model builder, frame sampler and curve
// helpers. Fixtures give it a tiny deterministic chart; real-catalog mode
// checks the counts against DremuTest. Both modes then open the overlay from
// the header button and verify it actually paints a lane stroke before close.
// ---------------------------------------------------------------------------

/** Exact class-token match: a host may carry several classes. */
function hasClassToken(node, token) {
  return String(node.className || '').split(/\s+/).indexOf(token) !== -1;
}

/** Assert a playback stat equals its expected value. */
function assertPlaybackStat(stats, key, expected) {
  assert.equal(stats[key], expected, 'playback stats.' + key + ' expected ' + expected + ', got ' + stats[key]);
}

/** Assert one number is within tolerance of the expected value. */
function assertApprox(actual, expected, tolerance, label) {
  assert.equal(typeof actual, 'number', label + ' is not a number: ' + actual);
  assert.ok(Number.isFinite(actual), label + ' is not finite: ' + actual);
  assert.ok(Math.abs(actual - expected) <= tolerance, label + ' expected ~' + expected + ', got ' + actual);
}

/** True when a canvas context recorded a stroke with a real line segment. */
function contextPaintedLineStroke(context) {
  const lineOps = ['lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc'];
  return (context.ops || []).some(function (op) {
    if (op.op !== 'stroke' || !Array.isArray(op.path)) return false;
    return op.path.some(function (entry) {
      return lineOps.indexOf(entry.op) !== -1;
    });
  });
}

/** Contexts that belong to the playback overlay canvas (not offscreen scratch canvases). */
function playbackCanvasContexts() {
  return canvasContexts.filter(function (context) {
    const element = context.__element;
    return !!element && hasClassToken(element, 'dgc-playerCanvas');
  });
}

const playback = clientPlugin.__playback;
assert.ok(playback, 'client plugin does not expose __playback');
for (const name of ['buildPlaybackModel', 'collectFrame', 'colorCurveAt', 'evalAdd']) {
  assert.equal(typeof playback[name], 'function', '__playback.' + name + ' is not a function');
}

const playbackModel = playback.buildPlaybackModel(stateResponse.project);
assert.ok(playbackModel && playbackModel.stats, 'buildPlaybackModel returned no stats');

if (!isRealMode) {
  // Fixture chart: one 20 s lane, a tap at 2 s, a hold at 6 s, plus a tap that
  // spawns at 21.11 s (outside the lane window) and is therefore unresolved.
  for (const [key, expected] of [
    ['mainLanes', 1],
    ['guideLanes', 0],
    ['notes', 3],
    ['boundNotes', 2],
    ['unresolvedNotes', 1],
    ['images', 0],
  ]) {
    assertPlaybackStat(playbackModel.stats, key, expected);
  }
  if ('skipped' in playbackModel.stats) assert.ok(Number.isFinite(playbackModel.stats.skipped), 'playback stats.skipped is not a number');

  // t = 2 is the tap's hit time: one live lane, one note exactly on the
  // judgement line at its lateral position (fixture position = -1).
  const frameAtHit = playback.collectFrame(playbackModel, 2);
  assert.equal(frameAtHit.lanes.length, 1, 'fixture frame t=2: expected 1 live lane, got ' + frameAtHit.lanes.length);
  assert.equal(frameAtHit.notes.length, 1, 'fixture frame t=2: expected exactly 1 visible note, got ' + frameAtHit.notes.length);
  assertApprox(frameAtHit.notes[0].x, -1, 1e-3, 'tap x at t=2');
  assertApprox(frameAtHit.notes[0].y, 0, 1e-3, 'tap y at t=2');
  assert.ok(Math.abs(frameAtHit.notes[0].rot) < 1e-3, 'tap rotation at the hit line must be ~0, got ' + frameAtHit.notes[0].rot);
  assert.equal(frameAtHit.holds.length, 0, 'fixture frame t=2: no hold is alive yet');

  // 0.3 s before the hit the head is still travelling: the fixture's default
  // distance curve is LinearFunctionCurve k=-8, so y = 8 * 0.3 = 2.4.
  const frameApproach = playback.collectFrame(playbackModel, 1.7);
  assert.equal(frameApproach.notes.length, 1, 'fixture frame t=1.7: expected the tap to be approaching, got ' + frameApproach.notes.length + ' notes');
  assertApprox(frameApproach.notes[0].y, 2.4, 1e-3, 'tap y at t=1.7');

  // The head is hidden once its hit time has passed.
  const frameAfterHit = playback.collectFrame(playbackModel, 2.5);
  assert.equal(frameAfterHit.notes.length, 0, 'the tap head must be hidden after its hit time, got ' + frameAfterHit.notes.length);

  // At the hold's hit time the body is sampled into 100 points starting on the
  // judgement line.
  const frameHold = playback.collectFrame(playbackModel, 6);
  assert.equal(frameHold.holds.length, 1, 'fixture frame t=6: expected the hold to be visible, got ' + frameHold.holds.length);
  assert.equal(frameHold.holds[0].points.length, 100, 'hold path must be sampled into 100 points, got ' + frameHold.holds[0].points.length);
  assertApprox(frameHold.holds[0].points[0][0], 0, 1e-3, 'hold first point x');
  assertApprox(frameHold.holds[0].points[0][1], 0, 1e-3, 'hold first point y');

  // Synthetic LerpColorCurve: alpha ramps 0 -> 1 over progress 0 -> 1.
  const lerpColor = {
    t: 'obj',
    type: 'GorgeFramework.LerpColorCurve',
    fields: {
      colorPoints: {
        t: 'arr',
        type: 'GorgeFramework.ColorArgb',
        items: [
          { t: 'obj', type: 'GorgeFramework.ColorArgb', fields: { a: 0, r: 1, g: 1, b: 1 } },
          { t: 'obj', type: 'GorgeFramework.ColorArgb', fields: { a: 1, r: 1, g: 1, b: 1 } },
        ],
      },
      progressCurve: {
        t: 'obj',
        type: 'GorgeFramework.LinearCurve',
        fields: { timeStart: 0, valueStart: 0, timeEnd: 1, valueEnd: 1 },
      },
    },
  };
  const midColor = playback.colorCurveAt(lerpColor, 0.5);
  assert.ok(midColor && typeof midColor === 'object', 'colorCurveAt returned no colour object');
  for (const channel of ['a', 'r', 'g', 'b']) {
    assert.equal(typeof midColor[channel], 'number', 'colorCurveAt colour is missing a numeric ' + channel);
  }
  assertApprox(midColor.a, 0.5, 0.02, 'LerpColorCurve alpha at x=0.5');
} else {
  // DremuTest: 33 main lanes, 69 guide lanes, 396 scored notes (taps, drags,
  // tapliks and holds), all bound; the storyboard staff contributes 8 images.
  for (const [key, expected] of [
    ['mainLanes', 33],
    ['guideLanes', 69],
    ['notes', 396],
    ['boundNotes', 396],
    ['unresolvedNotes', 0],
    ['images', 8],
  ]) {
    assertPlaybackStat(playbackModel.stats, key, expected);
  }
  if ('skipped' in playbackModel.stats) assert.ok(Number.isFinite(playbackModel.stats.skipped), 'playback stats.skipped is not a number');

  const frame = playback.collectFrame(playbackModel, 40, { aspect: 1.6, imageSize: () => ({ w: 200, h: 40 }) });
  assert.equal(frame.lanes.length, 8, 'real frame t=40: expected 8 live lanes, got ' + frame.lanes.length);
  assert.ok(frame.notes.length > 0, 'real frame t=40: expected visible notes, got none');
  assert.equal(frame.images.length, 1, 'real frame t=40: expected exactly 1 storyboard image, got ' + frame.images.length);

  // Guide lanes are drawn in the guide node's local space (offset along the main
  // lane + rotation to its normal). A note at position 0 must therefore sit on
  // its guide lane exactly at its hit time; this catches the node-transform bug
  // where the line was drawn with the main pose only.
  function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  const guideNotes = playbackModel.notes.filter((note) => {
    if (!note.lane || note.lane.kind !== 'guide' || !note.lane.usable) return false;
    const position = note.position;
    if (!position || !position.fields) return false;
    return Number(position.fields.baseValue || 0) === 0 && position.fields.variationCurve === undefined;
  });
  assert.ok(guideNotes.length > 0, 'real chart has no guide-lane notes to align');
  let aligned = 0;
  for (const note of guideNotes.slice(0, 12)) {
    const atHit = playback.collectFrame(playbackModel, note.start, { aspect: 1.6 });
    const laneFrame = atHit.lanes.find((lane) => lane.id === note.lane.id);
    const noteFrame = atHit.notes.find((item) => item.id === note.id);
    if (!laneFrame || !noteFrame) continue;
    let best = Infinity;
    const points = laneFrame.points;
    for (let index = 0; index + 1 < points.length; index += 1) {
      best = Math.min(best, segmentDistance(noteFrame.x, noteFrame.y, points[index][0], points[index][1], points[index + 1][0], points[index + 1][1]));
    }
    assert.ok(best < 0.6, 'guide note ' + note.id + ' is ' + best.toFixed(2) + ' units off its guide lane at hit time');
    aligned += 1;
  }
  assert.ok(aligned >= 3, 'not enough guide-lane notes exercised (' + aligned + ')');
  // Autoplay hit response: every note spawns a DremuRespondHint ring plus 16
  // heart particles at hitTime for 0.8 s; at +0.1 s both must exist and at
  // +0.9 s both must be gone.
  const responseNote = playbackModel.notes.find((note) => note.lane && note.lane.usable && note.start > 1);
  assert.ok(responseNote, 'real chart has no note to exercise the hit response');
  const effectFrame = playback.collectFrame(playbackModel, responseNote.start + 0.1, { aspect: 1.6 });
  const responseEffects = effectFrame.effects.filter((effect) => effect.id === responseNote.id);
  const ring = responseEffects.find((effect) => effect.kind === 'ring');
  assert.ok(ring, 'hit response has no ring at hitTime + 0.1');
  assert.ok(ring.size > 0 && ring.alpha > 0 && ring.alpha <= 1, 'ring size/alpha must be in range');
  assert.ok(responseEffects.filter((effect) => effect.kind === 'heart').length > 0, 'hit response has no heart particles');
  assert.equal(playback.collectFrame(playbackModel, responseNote.start + 0.9, { aspect: 1.6 }).effects.filter((effect) => effect.id === responseNote.id).length, 0, 'hit response outlives its 0.8 s window');
  // Curve regressions: the weighted CubicHermite must normalize tangents by the
  // y span (GorgeFramework AnimationCurveInterpolant), otherwise extreme
  // tangents overshoot (ArtLine3 drawStart used to reach -35 instead of ~-1.46).
  const artLine3 = playbackModel.lanes.find((lane) => lane.name === 'ArtLine3');
  assert.ok(artLine3, 'real chart has no ArtLine3 lane');
  const drawStart = playback.evalAdd(artLine3.drawStartX, 0.826);
  assert.ok(drawStart > -3 && drawStart < 0, 'weighted CubicHermite drawStart overshoot: ' + drawStart);
  // Piecewise bounds may be expr Infinity; the holdLine's last piece must not
  // be skipped (it produced a flat step in the hold body).
  const holdLineNote = playbackModel.notes.find((note) => note.kind === 'hold' && note.lane && note.lane.usable);
  assert.ok(holdLineNote, 'real chart has no hold to exercise Piecewise Infinity');
  const holdLineValue = playback.evalAdd(holdLineNote.holdLine, 0.5);
  assert.ok(holdLineValue < -0.3, 'Piecewise Infinity culled the holdLine tail: ' + holdLineValue);
  const holdFrame = playback.collectFrame(playbackModel, holdLineNote.start - 0.05, { aspect: 1.6 });
  const hold = holdFrame.holds.find((item) => item.id === holdLineNote.id);
  if (hold && hold.points.length > 10) {
    let maxStep = 0;
    for (let index = 1; index < hold.points.length; index += 1) {
      maxStep = Math.max(maxStep, Math.hypot(hold.points[index][0] - hold.points[index - 1][0], hold.points[index][1] - hold.points[index - 1][1]));
    }
    assert.ok(maxStep < 1.5, 'hold body has a discontinuous step: ' + maxStep);
  }
}

// ---- Stability sweep: sampling the whole timeline must never throw or
// produce NaN/Infinity geometry (both modes; no counts are asserted here) ----
const sweepDuration =
  stateResponse.project && Number.isFinite(stateResponse.project.duration) && stateResponse.project.duration > 0
    ? stateResponse.project.duration
    : 10;
const SWEEP_STEP = 0.5;
const sweepFrameCount = Math.min(300, Math.floor(sweepDuration / SWEEP_STEP) + 1);
const sweepOptions = { aspect: 1.6, imageSize: () => ({ w: 200, h: 40 }) };

/** Assert one sampled frame is structurally sound and every coordinate finite. */
function assertFiniteFrame(frame, time) {
  const where = ' (sweep t=' + time + ')';
  assert.ok(frame && typeof frame === 'object', 'collectFrame returned no frame' + where);
  for (const key of ['lanes', 'holds', 'notes', 'images']) {
    assert.ok(Array.isArray(frame[key]), 'collectFrame frame.' + key + ' is not an array' + where);
  }
  for (const lane of frame.lanes) {
    assert.ok(Array.isArray(lane.points), 'lane points missing' + where);
    for (const point of lane.points) {
      assert.ok(Number.isFinite(point[0]), 'lane point x is not finite' + where);
      assert.ok(Number.isFinite(point[1]), 'lane point y is not finite' + where);
    }
  }
  for (const hold of frame.holds) {
    assert.ok(Array.isArray(hold.points), 'hold points missing' + where);
    for (const point of hold.points) {
      assert.ok(Number.isFinite(point[0]), 'hold point x is not finite' + where);
      assert.ok(Number.isFinite(point[1]), 'hold point y is not finite' + where);
    }
  }
  for (const note of frame.notes) {
    assert.ok(Number.isFinite(note.x), 'note x is not finite' + where);
    assert.ok(Number.isFinite(note.y), 'note y is not finite' + where);
    assert.ok(Number.isFinite(note.rot), 'note rotation is not finite' + where);
    assert.ok(note.color && typeof note.color === 'object', 'note colour missing' + where);
    for (const channel of ['a', 'r', 'g', 'b']) {
      assert.ok(Number.isFinite(note.color[channel]), 'note colour ' + channel + ' is not finite' + where);
    }
  }
}

assert.ok(sweepFrameCount > 1, 'stability sweep has no frames to sample');
for (let index = 0; index < sweepFrameCount; index += 1) {
  const sweepTime = Math.min(sweepDuration, index * SWEEP_STEP);
  let sweepFrame = null;
  try {
    sweepFrame = playback.collectFrame(playbackModel, sweepTime, sweepOptions);
  } catch (error) {
    assert.fail('collectFrame threw at t=' + sweepTime + ': ' + (error && error.message ? error.message : error));
  }
  assertFiniteFrame(sweepFrame, sweepTime);
}

// Null / undefined typed values degrade to white instead of throwing.
for (const empty of [null, undefined]) {
  const white = playback.colorCurveAt(empty, 0.5);
  assert.ok(white && typeof white === 'object', 'colorCurveAt(' + empty + ') did not return a colour object');
  for (const channel of ['a', 'r', 'g', 'b']) {
    assertApprox(white[channel], 1, 1e-6, 'colorCurveAt(' + empty + ').' + channel);
  }
}

// ---- Overlay smoke: open from the header, assert the canvas painted, close --
const playbackOpenButton =
  findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join('').trim() === 'playbackOpen';
  }) || findClickableByText(tree, 'playbackOpen');
assert.ok(playbackOpenButton, 'header has no playbackOpen button');
playbackOpenButton.props.onClick({
  preventDefault() {},
  stopPropagation() {},
  target: playbackOpenButton,
  currentTarget: playbackOpenButton,
});
tree = await settle();

const playbackOverlay = findHost(tree, (host) => hasClassToken(host, 'dgc-player'));
assert.ok(playbackOverlay, 'playback overlay root (.dgc-player) did not mount');
const centerPane = findHost(tree, (host) => hasClassToken(host, 'dgc-center'));
assert.ok(centerPane, 'studio has no .dgc-center pane');
assert.ok(
  findHost({ rendered: centerPane.rendered }, (host) => hasClassToken(host, 'dgc-player')),
  'playback preview is not embedded inside .dgc-center',
);
const playbackCanvas = findHost(tree, (host) => host.tagName === 'CANVAS' && hasClassToken(host, 'dgc-playerCanvas'));
assert.ok(playbackCanvas, 'playback canvas (.dgc-playerCanvas) is missing');
assert.ok(playbackCanvas.getContext('2d'), 'playback canvas has no 2d context');

// A preview may paint from a requestAnimationFrame loop; the harness queues
// those callbacks, so flush a few frames when the first paint is missing.
if (!playbackCanvasContexts().some(contextPaintedLineStroke)) {
  for (let pass = 0; pass < 3; pass += 1) {
    if (flushAnimationFrames(1) === 0) break;
    tree = await settle();
  }
}
const paintedPlaybackContexts = playbackCanvasContexts();
assert.ok(paintedPlaybackContexts.length > 0, 'playback overlay created no dgc-playerCanvas context');
assert.ok(
  paintedPlaybackContexts.some(contextPaintedLineStroke),
  'playback canvas painted no lane stroke at t=0 (the project has a lane alive there)',
);

const playbackCloseButton =
  findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join('').trim() === 'playbackClose';
  }) || findClickableByText(tree, 'playbackClose');
assert.ok(playbackCloseButton, 'playback overlay has no playbackClose button');
playbackCloseButton.props.onClick({
  preventDefault() {},
  stopPropagation() {},
  target: playbackCloseButton,
  currentTarget: playbackCloseButton,
});
tree = await settle();
assert.ok(!findHost(tree, (host) => hasClassToken(host, 'dgc-player')), 'playback overlay (.dgc-player) did not unmount after close');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const finalHosts = flattenHosts(tree, []);
console.log('client-smoke: OK');
console.log(
  '  components rendered:',
  new Set(flattenComponents(tree, []).map((component) => component.name)).size,
  '| host nodes:',
  finalHosts.length,
  '| canvases:',
  finalHosts.filter((host) => host.tagName === 'CANVAS').length,
  '| fetch calls:',
  calls.length,
);
console.log('  canvas text layout: ' + canvasTextRuns + ' runs, no overlap, nothing outside the gutter column');
console.log('  slots: sidebar.panellist#gorge-chart + main#gorge-chart');
console.log('  verified: page chrome, project/lane/element data, timeline paint, element selection,');
console.log('            inspector fields, curve dialog (plot canvas + numeric tree), apply/undo/save round trips,');
console.log('            note drag -> patch(hitTime), undo -> inverse patch, redo, tap placement -> add op,');
console.log('            addStaff dialog -> addStaff op (chart + storyboard), the element palette -> add op,');
console.log('            the staff right-click menu -> setStaffName / removeStaff(deleteFile) ops,');
console.log('            the audio-period dialog -> addAudioPeriod / clip drag -> patchAudioPeriod ops,');
console.log('            the audio-strip right-click menu -> waveform/spectrum mode,');
console.log('            and auto-BPM detection -> setMeta.tempo.');
