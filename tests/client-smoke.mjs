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
 *   4. the inspector and the docked curve panel render a real element/catalog,
 *   5. curve-panel Apply, segment creation/type change/delete and boundary
 *      drags produce the expected patch values.
 *
 * Run: node tests/client-smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCurve } from '../dremu-model.js';

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

const VARIABLE_FLOAT_VALUE_TYPE = {
  label: 'VariableFloat',
  fields: {
    baseValue: { name: 'baseValue', type: 'number', default: 0, label: 'Base value' },
    variationCurve: { name: 'variationCurve', type: 'curve', optional: true, label: 'Variation curve' },
  },
};

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
        {
          name: 'position',
          type: 'VariableFloat',
          default: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: 0 } },
          schema: VARIABLE_FLOAT_VALUE_TYPE,
          fields: VARIABLE_FLOAT_VALUE_TYPE.fields,
        },
        { name: 'curves', type: 'array', label: 'Curves', itemSchema: { type: 'curve', label: 'Curve' }, default: [] },
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
        {
          name: 'color',
          type: 'LerpColorCurve',
          optional: true,
          label: 'Color',
          default: {
            t: 'obj',
            type: 'GorgeFramework.LerpColorCurve',
            fields: {
              colorPoints: {
                t: 'arr',
                type: 'GorgeFramework.ColorArgb',
                items: [{ t: 'obj', type: 'GorgeFramework.ColorArgb', fields: { a: 1, r: 1, g: 1, b: 1 } }],
              },
            },
          },
        },
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
  valueTypes: { VariableFloat: VARIABLE_FLOAT_VALUE_TYPE },
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
                curves: {
                  t: 'arr',
                  type: 'GorgeFramework.FunctionCurve',
                  items: [{ t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 1, valueEnd: 0 } }],
                },
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
// Curve segment model + sampler parity (pure helpers, no DOM)
// ---------------------------------------------------------------------------
{
  const curve = clientPlugin.__curve;
  assert.ok(curve && typeof curve.readCurveDraft === 'function', 'client exposes no __curve test helpers');
  for (const name of ['sampleCurve', 'readCurveDraft', 'buildCurveValue', 'normalizeSegments', 'setSegmentBoundary', 'splitCurveSegment', 'addCurveSegmentOutside', 'deleteCurveSegment', 'changeCurveSegmentType', 'defaultSegmentCurve', 'curveNaturalRange', 'curveInitialView', 'curveAlignedView', 'curveValueRange', 'curveParamHandles', 'curveBoundaryWarnings', 'autoFixCurveBoundaryJumps', 'offsetCurveValue', 'snapCurveTime', 'curveLayout']) {
    assert.equal(typeof curve[name], 'function', '__curve.' + name + ' is not a function');
  }

  const linear = { t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 2, valueEnd: 1 } };
  const draft = curve.readCurveDraft(linear, { fallbackRange: [-1, 1] });
  assert.equal(draft.rootKind, 'curve');
  assert.equal(draft.segments.length, 1);
  assert.equal(draft.segments[0].start, 0);
  assert.equal(draft.segments[0].end, 2);
  assert.deepEqual(curve.buildCurveValue(draft), linear, 'an untouched draft must round-trip the original value');

  const constant = (value) => ({ t: 'obj', type: 'GorgeFramework.ConstantFunctionCurve', fields: { value } });
  const piecewise = {
    t: 'obj',
    type: 'GorgeFramework.PiecewiseFunctionCurve',
    fields: {
      functionPieces: {
        t: 'arr',
        type: 'GorgeFramework.FunctionPiece',
        items: [
          { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(1), startX: 0, endX: 1 } },
          { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(2), startX: 1, endX: 2 } },
        ],
      },
    },
  };
  const axial = { t: 'obj', type: 'GorgeFramework.AxialSymmetricFunctionCurve', fields: { functionCurve: { t: 'obj', type: 'GorgeFramework.LinearFunctionCurve', fields: { k: 1, b: 0 } } } };
  const periodic = { t: 'obj', type: 'GorgeFramework.PeriodicFunctionCurve', fields: { functionCurve: { t: 'obj', type: 'GorgeFramework.LinearFunctionCurve', fields: { k: 1, b: 0 } } } };
  const addition = { t: 'obj', type: 'GorgeFramework.AdditionFunctionCurve', fields: { firstFunctionCurve: constant(3), secondFunctionCurve: constant(4) } };
  const composite = {
    t: 'obj',
    type: 'GorgeFramework.CompositeFunctionCurve',
    fields: {
      outerFunctionCurve: { t: 'obj', type: 'GorgeFramework.LinearFunctionCurve', fields: { k: 2, b: 0 } },
      innerFunctionCurve: { t: 'obj', type: 'GorgeFramework.LinearFunctionCurve', fields: { k: 1, b: 1 } },
    },
  };
  const flatSpline = {
    t: 'obj',
    type: 'GorgeFramework.CubicHermiteSpline',
    fields: {
      startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0.5 } },
      endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 0.5 } },
      startTangent: 3,
      endTangent: -2,
    },
  };
  const cases = [piecewise, axial, periodic, addition, composite, flatSpline];
  const xs = [-0.5, 0, 0.25, 0.5, 0.999999, 1, 1.5, 2, 2.5];
  for (const value of cases) {
    for (const x of xs) {
      const actual = curve.sampleCurve(value, x);
      const expected = evaluateCurve(value, x);
      if (expected === null) assert.equal(actual, null);
      else {
        assert.equal(typeof actual, 'number', 'sampleCurve returned a non-number for ' + value.type + ' at ' + x);
        assert.ok(Math.abs(actual - expected) < 1e-6, 'sampleCurve drift for ' + value.type + ' at ' + x + ': ' + actual + ' vs ' + expected);
      }
    }
  }
  assert.equal(curve.sampleCurve(piecewise, 1), 0, 'piecewise boundaries are open by default');
  assert.equal(curve.sampleCurve(axial, -1), 1, 'axial default keepLeft=false must mirror the right side');
  assert.equal(curve.sampleCurve(addition, 0), 7, 'addition must use firstFunctionCurve/secondFunctionCurve');
  assert.equal(curve.sampleCurve(composite, 2), 6, 'composite must evaluate outer(inner(x))');
  assert.equal(curve.sampleCurve(flatSpline, 0.5), 0.5, 'flat spline must return the start value');

  const view = { x0: -1, x1: 3 };
  const split = curve.splitCurveSegment(draft, 0, 1, 'LinearCurve', { view });
  assert.equal(split.draft.segments.length, 2);
  assert.equal(split.draft.converted, true, 'splitting a plain curve must convert it');
  assert.equal(split.draft.segments[0].end, split.draft.segments[1].start, 'segments must share their boundary');
  const built = curve.buildCurveValue(split.draft);
  assert.equal(built.type, 'GorgeFramework.PiecewiseFunctionCurve');
  assert.equal(built.fields.functionPieces.items.length, 2);
  assert.equal(built.fields.functionPieces.items[0].fields.endX, built.fields.functionPieces.items[1].fields.startX);
  for (const x of [-0.5, 0, 0.5, 1, 1.5, 2]) {
    assert.ok(Math.abs(curve.sampleCurve(built, x) - curve.sampleCurve(linear, x)) < 1e-6, 'a same-type split changed the function at ' + x);
  }

  const changed = curve.changeCurveSegmentType(draft, 0, 'ConstantFunctionCurve', { view });
  assert.equal(changed.segments.length, 1);
  assert.equal(curve.buildCurveValue(changed).type, 'GorgeFramework.ConstantFunctionCurve', 'single-segment type changes must not wrap in piecewise');
  const retyped = curve.buildCurveValue(changed);
  assert.equal(curve.sampleCurve(retyped, 1), 0, 'constant type change anchors to the segment start value');

  const dragged = curve.setSegmentBoundary(draft, 1, 1.5, {});
  assert.equal(dragged.converted, true, 'dragging a plain curve boundary must convert it');
  assert.equal(dragged.segments[0].end, 1.5);
  assert.equal(curve.buildCurveValue(dragged).type, 'GorgeFramework.PiecewiseFunctionCurve');

  const outside = curve.addCurveSegmentOutside(split.draft, 3, 'LinearCurve', { view });
  assert.equal(outside.draft.segments.length, 3);
  assert.equal(outside.draft.segments[1].end, outside.draft.segments[2].start);
  assert.equal(outside.draft.segments[2].end, 3);
  const outsideLeft = curve.addCurveSegmentOutside(split.draft, -1, 'LinearCurve', { view });
  assert.equal(outsideLeft.draft.segments.length, 3);
  assert.equal(outsideLeft.draft.segments[0].start, -1);
  assert.equal(outsideLeft.draft.segments[0].end, outsideLeft.draft.segments[1].start);

  const three = curve.splitCurveSegment(split.draft, 1, 1.5, 'LinearCurve', { view }).draft;
  assert.equal(three.segments.length, 3);
  const deleted = curve.deleteCurveSegment(three, 1);
  assert.equal(deleted.draft.segments.length, 2);
  assert.equal(deleted.draft.segments[0].end, deleted.draft.segments[1].start, 'deleting a segment must keep the remainder contiguous');

  const snapped = curve.snapCurveTime(0.42, { bpm: 120, offset: 0 }, 4, 1.25, true);
  assert.ok(Math.abs(snapped - 0.375) < 1e-9, 'snapCurveTime did not snap to the 1/4 beat grid: ' + snapped);

  const initial = curve.curveInitialView(draft, { bpm: 120, offset: 0 }, [-1, 1]);
  assert.ok(initial.x1 > initial.x0);
  const layout = curve.curveLayout(800, 420, { x0: initial.x0, x1: initial.x1, y0: -1, y1: 1 });
  assert.ok(layout.toX(0) > layout.left && layout.toX(0) < layout.left + layout.plotW);
  assert.ok(layout.toY(0) < layout.plotBottom && layout.toY(0) > layout.plotTop);

  // The aligned view uses the main timeline's t0/pps so a beat line lands on
  // the same screen x as the main ruler (GUTTER_W + (t - t0) * pps).
  const mainView = { t0: 0, pps: 46 };
  const alignedView = curve.curveAlignedView(6, mainView, 634);
  assert.ok(alignedView, 'curveAlignedView returned null');
  const alignedLayout = curve.curveLayout(800, 420, { x0: alignedView.x0, x1: alignedView.x1, y0: -1, y1: 1 });
  assert.ok(Math.abs(alignedLayout.toX(0) - (148 + 6 * 46)) < 1e-9, 'aligned anchor x must match the main ruler');
  assert.ok(Math.abs(alignedLayout.toX(1) - (148 + 7 * 46)) < 1e-9, 'aligned beat x must match the main ruler');

  const handles = curve.curveParamHandles(linear, { start: 0, end: 2, view: { x0: -1, x1: 3 } });
  assert.ok(handles.length >= 2, 'LinearCurve must expose two key handles');
  const draggedHandle = handles[0];
  const nextCurve = draggedHandle.drag(0.5, 0.7);
  assert.ok(Math.abs(curve.sampleCurve(nextCurve, 0.5) - 0.7) < 1e-6, 'dragging a LinearCurve key did not move its value');

  for (const type of ['ConstantFunctionCurve', 'LinearFunctionCurve', 'LinearCurve', 'CubicHermiteSpline', 'PeriodicFunctionCurve', 'AxialSymmetricFunctionCurve', 'AdditionFunctionCurve', 'CompositeFunctionCurve']) {
    const curveValue = curve.defaultSegmentCurve(type, 0, 2, 1, 3);
    const typeHandles = curve.curveParamHandles(curveValue, { start: 0, end: 2, view: { x0: -1, x1: 3 } });
    if (type === 'CompositeFunctionCurve') assert.equal(typeHandles.length, 0, 'composite curves are numeric-only');
    else {
      assert.ok(typeHandles.length > 0, 'no draggable parameter handles for ' + type);
      const movable = typeHandles.find((handle) => handle.yEditable);
      if (movable) {
        const after = movable.drag(movable.x, movable.y + 0.25);
        assert.ok(after && typeof after === 'object', 'handle drag for ' + type + ' returned no curve');
      }
    }
  }

  const jumpDraft = curve.readCurveDraft(piecewise, { fallbackRange: [-1, 1] });
  const jumps = curve.curveBoundaryWarnings(jumpDraft);
  assert.equal(jumps.length, 1, 'a 1 -> 2 boundary must be reported as a jump');
  assert.equal(jumps[0].left, 1);
  assert.equal(jumps[0].right, 2);

  const fixedJump = curve.autoFixCurveBoundaryJumps(jumpDraft);
  assert.equal(curve.curveBoundaryWarnings(fixedJump).length, 0, 'auto-fix left a value jump behind');
  assert.equal(fixedJump.edited, true, 'auto-fix must mark the draft as edited');
  assert.equal(fixedJump.segments.length, jumpDraft.segments.length, 'auto-fix changed the segment count');
  assert.equal(fixedJump.segments[1].curve.fields.value, 1, 'auto-fix did not shift the right constant to the left value');

  const cascadeValue = {
    t: 'arr',
    type: 'GorgeFramework.FunctionPiece',
    items: [
      { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(1), startX: 0, endX: 1 } },
      { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(2), startX: 1, endX: 2 } },
      { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(4), startX: 2, endX: 3 } },
    ],
  };
  const cascadeDraft = curve.readCurveDraft(
    { t: 'obj', type: 'GorgeFramework.PiecewiseFunctionCurve', fields: { functionPieces: cascadeValue } },
    { fallbackRange: [-1, 1] },
  );
  assert.equal(curve.curveBoundaryWarnings(cascadeDraft).length, 2);
  const cascadeFixed = curve.autoFixCurveBoundaryJumps(cascadeDraft);
  assert.equal(curve.curveBoundaryWarnings(cascadeFixed).length, 0, 'auto-fix did not cascade through multiple boundaries');
  assert.ok(cascadeFixed.segments.every((segment) => segment.curve.fields.value === 1), 'cascade auto-fix should meet the first segment value');

  const compositeJump = curve.readCurveDraft(
    {
      t: 'obj',
      type: 'GorgeFramework.PiecewiseFunctionCurve',
      fields: {
        functionPieces: {
          t: 'arr',
          type: 'GorgeFramework.FunctionPiece',
          items: [
            { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(0), startX: 0, endX: 1 } },
            { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: composite, startX: 1, endX: 2 } },
          ],
        },
      },
    },
    { fallbackRange: [-1, 1] },
  );
  const compositeFixed = curve.autoFixCurveBoundaryJumps(compositeJump);
  assert.equal(curve.curveBoundaryWarnings(compositeFixed).length, 0, 'auto-fix failed for a composite curve');
  assert.equal(compositeFixed.segments[1].curve.type, 'GorgeFramework.AdditionFunctionCurve', 'composite auto-fix should wrap the original curve with an addition offset');
  assert.ok(Math.abs(curve.sampleCurve(compositeFixed.segments[1].curve, 1)) < 1e-6, 'composite auto-fix did not shift the boundary value');

  // Walk every piecewise curve in the loaded project: the real corpus has
  // infinite bounds, zero-length head pieces and omitted closed flags; an
  // untouched read/build must round-trip all of them.
  let piecewiseCount = 0;
  const walkCurves = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walkCurves(item);
      return;
    }
    if (node.t === 'arr') {
      for (const item of Array.isArray(node.items) ? node.items : []) walkCurves(item);
      return;
    }
    if (node.t === 'expr' || node.t === 'ref') return;
    if (node.t === 'obj') {
      const type = curve.curveTypeOf(node);
      if (type === 'PiecewiseFunctionCurve' || type === 'PiecewiseCurve') {
        const model = curve.readCurveDraft(node, { fallbackRange: [-1, 1] });
        assert.ok(model.segments.length >= 1, 'piecewise curve read with no segments');
        assert.deepEqual(curve.buildCurveValue(model), node, 'an untouched piecewise read/build must round-trip');
        model.edited = true;
        const rebuilt = curve.buildCurveValue(model);
        assert.equal(rebuilt.type, 'GorgeFramework.PiecewiseFunctionCurve');
        const rebuiltItems = rebuilt.fields.functionPieces.items;
        assert.equal(rebuiltItems.length, model.segments.length);
        for (let index = 0; index < rebuiltItems.length; index += 1) {
          assert.ok(rebuiltItems[index].fields.functionCurve && rebuiltItems[index].fields.functionCurve.t === 'obj', 'edited pieces must materialize a function curve');
          if (index > 0) assert.deepEqual(rebuiltItems[index].fields.startX, rebuiltItems[index - 1].fields.endX, 'edited pieces must be contiguous');
        }
        for (const segment of model.segments) {
          const segmentHandles = curve.curveParamHandles(segment.curve, {
            start: segment.start,
            end: segment.end,
            view: { x0: -1, x1: 1, y0: -1, y1: 1 },
          });
          assert.ok(Array.isArray(segmentHandles), 'parameter handles failed for a corpus curve');
        }
        piecewiseCount += 1;
      }
      const fields = node.fields || {};
      for (const name of Object.keys(fields)) walkCurves(fields[name]);
      return;
    }
    // Plain project/staff/period/element/field objects.
    for (const key of Object.keys(node)) walkCurves(node[key]);
  };
  walkCurves(stateResponse.project);
  if (process.env.GORGE_SMOKE_REAL === '1') assert.ok(piecewiseCount > 0, 'the real corpus must contain piecewise curves');

  // The real corpus has a zero-length `functionCurve : null` piece at the head
  // of many holdLine curves; normalizing it must not shift the following piece.
  const withEmptyHead = {
    t: 'obj',
    type: 'GorgeFramework.PiecewiseFunctionCurve',
    fields: {
      functionPieces: {
        t: 'arr',
        type: 'GorgeFramework.FunctionPiece',
        items: [
          { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: null, startX: 0, endX: 0 } },
          { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(5), startX: 0, endX: 2 } },
        ],
      },
    },
  };
  const emptyDraft = curve.readCurveDraft(withEmptyHead, { fallbackRange: [-1, 1] });
  assert.equal(emptyDraft.segments.length, 2);
  assert.equal(emptyDraft.segments[0].start, 0);
  assert.equal(emptyDraft.segments[0].end, 0);
  assert.equal(emptyDraft.segments[1].start, 0, 'a zero-length head piece must not shift the next piece');
  assert.equal(emptyDraft.segments[1].end, 2);
  emptyDraft.edited = true;
  const emptyBuilt = curve.buildCurveValue(emptyDraft);
  assert.equal(emptyBuilt.fields.functionPieces.items[0].fields.endX, 0);
  assert.equal(emptyBuilt.fields.functionPieces.items[1].fields.startX, 0);
  assert.equal(curve.sampleCurve(emptyBuilt, 0.25), 5, 'the zero-length head must not shadow the following piece');

  // Infinite outer bounds are preserved as the corpus' (-1.0/0.0) / (1.0/0.0)
  // expressions until the user materializes them.
  const infiniteValue = {
    t: 'obj',
    type: 'GorgeFramework.PiecewiseFunctionCurve',
    fields: {
      functionPieces: {
        t: 'arr',
        type: 'GorgeFramework.FunctionPiece',
        items: [
          {
            t: 'obj',
            type: 'GorgeFramework.FunctionPiece',
            fields: {
              functionCurve: constant(1),
              startX: { t: 'expr', src: '(-1.0/0.0)', special: '-Infinity' },
              endX: 0,
            },
          },
          { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(2), startX: 0, endX: { t: 'expr', src: '(1.0/0.0)', special: 'Infinity' } } },
        ],
      },
    },
  };
  const infiniteDraft = curve.readCurveDraft(infiniteValue, { fallbackRange: [-1, 1] });
  assert.equal(infiniteDraft.segments[0].start, -Infinity);
  assert.equal(infiniteDraft.segments[1].end, Infinity);
  infiniteDraft.edited = true;
  const infiniteBuilt = curve.buildCurveValue(infiniteDraft);
  assert.equal(infiniteBuilt.fields.functionPieces.items[0].fields.startX.special, '-Infinity');
  assert.equal(infiniteBuilt.fields.functionPieces.items[1].fields.endX.special, 'Infinity');
  const finiteStart = curve.setSegmentBoundary(infiniteDraft, 0, -2, {});
  assert.equal(finiteStart.segments[0].start, -2);
  const finiteStartBuilt = curve.buildCurveValue(finiteStart);
  assert.equal(finiteStartBuilt.fields.functionPieces.items[0].fields.startX, -2);
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
    // The curve panel has its own 56px gutter and plot-area labels; the
    // timeline gutter rules below do not apply to its canvas.
    if (context.__element && String(context.__element.className || '').split(/\s+/).indexOf('dgc-curveCanvas') !== -1) continue;
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
// Inspector + docked curve panel with a real selection
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

/** Optional-field checkbox identified by its data-field attribute. */
function findOptionalToggle(tree, field) {
  return findHost(
    tree,
    (host) =>
      host.tagName === 'INPUT' &&
      host.props &&
      host.props.type === 'checkbox' &&
      host.props['data-field'] === field,
  );
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

// 2. Open the docked curve panel from the hold's curve field.
const curveApi = clientPlugin.__curve;
const openCurvePanel = async () => {
  const button = findHost(tree, (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'curveEditor');
  assert.ok(button, 'curve editor button not found for the curve field');
  button.props.onClick({ preventDefault() {}, stopPropagation() {}, target: button });
  tree = await settle();
  return findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  });
};
const curveCanvasHost = () => flattenHosts(tree, []).find((host) => host.tagName === 'CANVAS' && hasClassToken(host, 'dgc-curveCanvas'));
const segmentRowHosts = () => flattenHosts(tree, []).filter((host) => hasClassToken(host, 'dgc-curveSeg'));
const applyLastCurve = async (applyHost) => {
  assert.ok(applyHost, 'curve panel apply button not found');
  applyHost.props.onClick({ preventDefault() {}, stopPropagation() {}, target: applyHost });
  tree = await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return editBodies[editBodies.length - 1];
};

let curveApplyButton = await openCurvePanel();
assert.ok(flattenText(tree, []).join(' ').includes('curveEditor'), 'curve panel did not open');
const dialogCanvases = flattenHosts(tree, []).filter((host) => host.tagName === 'CANVAS');
assert.ok(dialogCanvases.length >= 2, 'curve panel did not render its plot canvas');
const centerHost = flattenHosts(tree, []).find((host) => hasClassToken(host, 'dgc-center'));
assert.ok(centerHost, 'center pane missing');
const centerHosts = flattenHosts(centerHost.rendered, []);
const curveLayerHost = centerHosts.find((host) => hasClassToken(host, 'dgc-curveLayer'));
assert.ok(curveLayerHost, 'curve panel is not docked inside the center pane');
assert.ok(hasClassToken(centerHost, 'has-curve'), 'center pane did not enter the split layout');
assert.ok(
  !curveLayerHost.props.style || curveLayerHost.props.style.position !== 'absolute',
  'curve layer must be a flow child under the timeline, not a full-pane overlay',
);
assert.ok(
  centerHost.props.style && typeof centerHost.props.style['--dgc-timeline-h'] === 'string',
  'center pane did not receive the timeline content height',
);
const timelineWrapHost = centerHosts.find((host) => hasClassToken(host, 'dgc-canvasWrap'));
assert.ok(timelineWrapHost, 'timeline canvas wrap missing');
const timelineWrapIndex = centerHosts.indexOf(timelineWrapHost);
const curveLayerIndex = centerHosts.indexOf(curveLayerHost);
assert.ok(timelineWrapIndex >= 0 && timelineWrapIndex < curveLayerIndex, 'curve layer must follow the timeline in the center column');
const curveCanvas = curveCanvasHost();
assert.ok(curveCanvas, 'curve canvas missing');
const curveContext = canvasContexts.find((context) => context.__element && String(context.__element.className || '').split(/\s+/).indexOf('dgc-curveCanvas') !== -1);
assert.ok(curveContext, 'curve canvas has no 2D context');
const curveRuns = curveContext.drawn.map((item) => item.text).join(' | ');
assert.ok(curveRuns.includes('♪'), 'curve panel did not paint beat labels');
assert.ok(curveRuns.includes('LinearCurve'), 'curve panel did not paint the segment label');
// The curve panel's x axis mirrors the main timeline: zooming the main
// timeline must repaint the panel's beat grid at the new scale.
const latestCurveContext = () => {
  for (let index = canvasContexts.length - 1; index >= 0; index -= 1) {
    const context = canvasContexts[index];
    const cls = String((context.__element && context.__element.className) || '');
    if (cls.split(/\s+/).indexOf('dgc-curveCanvas') !== -1) return context;
  }
  return curveContext;
};
const beatXs = () => latestCurveContext().drawn.filter((item) => /^♪/.test(item.text)).map((item) => item.x);
const beatXsBeforeSync = beatXs();
const mainZoomIn = findHost(tree, (host) => host.props && host.props.title === 'zoomIn' && typeof host.props.onClick === 'function');
const mainZoomOut = findHost(tree, (host) => host.props && host.props.title === 'zoomOut' && typeof host.props.onClick === 'function');
assert.ok(mainZoomIn && mainZoomOut, 'main timeline zoom buttons missing');
mainZoomIn.props.onClick({ preventDefault() {}, stopPropagation() {}, target: mainZoomIn });
tree = await settle();
const beatXsAfterZoom = beatXs();
assert.notDeepEqual(beatXsAfterZoom, beatXsBeforeSync, 'curve panel did not follow the main timeline zoom');
mainZoomOut.props.onClick({ preventDefault() {}, stopPropagation() {}, target: mainZoomOut });
tree = await settle();
const beatXsAfterRestore = beatXs();
assert.equal(beatXsAfterRestore.length, beatXsBeforeSync.length, 'curve panel beat label count changed after restoring zoom');
for (let index = 0; index < beatXsAfterRestore.length; index += 1) {
  assert.ok(Math.abs(beatXsAfterRestore[index] - beatXsBeforeSync[index]) < 0.51, 'curve panel did not restore its aligned beat grid');
}
// Scrolling the curve panel's plot must scroll the main timeline (and the
// panel follows it), so the two views never drift apart horizontally.
const scrollCurvePanel = (deltaX) => {
  const host = curveCanvasHost();
  assert.ok(host, 'curve canvas disappeared before the horizontal scroll check');
  host.props.onWheel({
    clientX: 320,
    clientY: 220,
    deltaX,
    deltaY: 0,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
};
const beatXsBeforeScroll = beatXs();
scrollCurvePanel(80);
tree = await settle();
const beatXsAfterScroll = beatXs();
assert.notDeepEqual(beatXsAfterScroll, beatXsBeforeScroll, 'scrolling the curve panel did not move the shared time view');
scrollCurvePanel(-80);
tree = await settle();
const beatXsAfterScrollBack = beatXs();
for (let index = 0; index < beatXsAfterScrollBack.length; index += 1) {
  assert.ok(Math.abs(beatXsAfterScrollBack[index] - beatXsBeforeScroll[index]) < 0.51, 'curve panel did not restore its x view after scrolling back');
}
const dialogText = flattenText(tree, []).join(' ');
assert.ok(dialogText.includes('curveSegments'), 'curve panel segment list missing');
assert.ok(dialogText.includes('curveNewSegment'), 'curve panel new-segment action missing');
assert.ok(dialogText.includes('curveFunctionType'), 'curve panel function-type selector missing');
assert.ok(dialogText.includes('curveParams'), 'curve panel parameter editor missing');
assert.ok(dialogText.includes('curveBeatGrid'), 'curve panel beat-grid hint missing');
assert.ok(dialogText.includes('LinearCurve'), 'curve panel did not show the curve type');
assert.equal(segmentRowHosts().length, 1, 'a plain LinearCurve must open as exactly one segment');
// The numeric editor must expose the LinearCurve fields (raw names in the
// fixture catalog; localized labels in the real catalog).
assert.ok(dialogText.includes('timeStart') || dialogText.includes('开始时间'), 'curve panel time fields missing');
assert.ok(dialogText.includes('curveWillConvert'), 'plain curves must advertise the conversion policy');
const deleteSegmentButton = findHost(tree, (host) => host.props && host.props.title === 'curveDeleteSegment');
assert.ok(deleteSegmentButton, 'curve panel delete-segment button missing');
assert.equal(deleteSegmentButton.props.disabled, true, 'the only segment must not be deletable');

// 3. Apply without edits: one edit op must be queued to the Host.
const editCallsBefore = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
const firstApplied = await applyLastCurve(curveApplyButton);
const editCallsAfter = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
assert.ok(editCallsAfter > editCallsBefore, 'applying the curve did not POST an edit');
assert.ok(firstApplied && Array.isArray(firstApplied.ops), 'curve apply did not emit an op batch');
assert.ok(!flattenHosts(tree, []).some((host) => hasClassToken(host, 'dgc-curveLayer')), 'curve panel did not close after apply');

// 4. Changing the type of a single synthetic segment keeps the plain type.
//    (Fixture mode only: this uses the holdLine curve geometry.)
if (!isRealMode) {
  const curveFallback = [-1, 1];
  const curveTestPlotWidth = curveApi.curveLayout(800, 420, { x0: 0, x1: 1, y0: -1, y1: 1 }).plotW;
  const curveTestMainView = { t0: 0, pps: 46 };
  const fixtureHold = PROJECT.staffs[0].periods[0].elements.find((element) => element.type === 'Dremu.DremuHold');
  const alignedCurveView = () =>
    curveApi.curveAlignedView(fixtureHold.start, curveTestMainView, curveTestPlotWidth);
  const geometryForValue = (value) => {
    const model = curveApi.readCurveDraft(value, { fallbackRange: curveFallback });
    const nextView = alignedCurveView() || curveApi.curveInitialView(model, { bpm: 120, offset: 0 }, curveFallback);
    return curveApi.curveLayout(800, 420, { x0: nextView.x0, x1: nextView.x1, y0: -1, y1: 1 });
  };
  const holdLineValue = fixtureHold.fields.holdLine;
  const baseDraft = curveApi.readCurveDraft(holdLineValue, { fallbackRange: curveFallback });
  const baseView = alignedCurveView() || curveApi.curveInitialView(baseDraft, { bpm: 120, offset: 0 }, curveFallback);
  const baseYRange = curveApi.curveValueRange(baseDraft, baseView);
  const baseGeometry = curveApi.curveLayout(800, 420, { x0: baseView.x0, x1: baseView.x1, y0: baseYRange[0], y1: baseYRange[1] });

  // 4a. Dragging a per-type parameter handle edits the plain curve in place.
  curveApplyButton = await openCurvePanel();
  const paramCanvas = curveCanvasHost();
  paramCanvas.props.onPointerDown({
    clientX: baseGeometry.toX(2),
    clientY: baseGeometry.toY(1),
    pointerId: 21,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: paramCanvas,
  });
  paramCanvas.props.onPointerMove({
    clientX: baseGeometry.toX(2),
    clientY: baseGeometry.toY(0.5),
    pointerId: 21,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: paramCanvas,
  });
  paramCanvas.props.onPointerUp({
    clientX: baseGeometry.toX(2),
    clientY: baseGeometry.toY(0.5),
    pointerId: 21,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: paramCanvas,
  });
  tree = await settle();
  const paramApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const paramOp = paramApplied.ops.find((op) => op.op === 'patch');
  assert.ok(paramOp, 'parameter drag did not emit a patch op');
  assert.equal(paramOp.value.type, 'GorgeFramework.LinearCurve', 'a parameter drag must not convert the curve');
  assert.ok(Math.abs(paramOp.value.fields.valueEnd - 0.5) < 1e-6, 'parameter drag did not update valueEnd: ' + paramOp.value.fields.valueEnd);
  assert.equal(paramOp.value.fields.valueStart, 0);

  // 4a-bis. Every function type renders, paints and exposes an editor without
  //        throwing; cancel discards the draft.
  curveApplyButton = await openCurvePanel();
  const allTypeSelect = findHost(tree, (host) => {
    return host.tagName === 'SELECT' && host.props && host.props.value === 'LinearCurve' && typeof host.props.onChange === 'function';
  });
  assert.ok(allTypeSelect, 'function-type selector missing for the all-types pass');
  for (const type of ['ConstantFunctionCurve', 'LinearFunctionCurve', 'LinearCurve', 'CubicHermiteSpline', 'PeriodicFunctionCurve', 'AxialSymmetricFunctionCurve', 'AdditionFunctionCurve', 'CompositeFunctionCurve']) {
    allTypeSelect.props.onChange({ target: { value: type } });
    tree = await settle();
    assert.ok(flattenText(tree, []).join(' ').includes('curveParams'), 'type editor missing after switching to ' + type);
  }
  const resetCurve = findHost(tree, (host) => host.props && host.props.title === 'reset' && typeof host.props.onClick === 'function');
  assert.ok(resetCurve, 'curve panel reset button missing');
  resetCurve.props.onClick({ preventDefault() {}, stopPropagation() {}, target: resetCurve });
  tree = await settle();
  assert.ok(
    findHost(tree, (host) => host.tagName === 'SELECT' && host.props && host.props.value === 'LinearCurve'),
    'reset did not restore the original LinearCurve segment',
  );
  const cancelCurve = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'cancel';
  });
  assert.ok(cancelCurve, 'curve panel cancel button missing');
  cancelCurve.props.onClick({ preventDefault() {}, stopPropagation() {}, target: cancelCurve });
  tree = await settle();
  assert.ok(!flattenHosts(tree, []).some((host) => hasClassToken(host, 'dgc-curveLayer')), 'cancel did not close the curve panel');

  // 4b. Changing the type of a single synthetic segment keeps the plain type.
  curveApplyButton = await openCurvePanel();
  const typeSelect = findHost(tree, (host) => {
    return host.tagName === 'SELECT' && host.props && host.props.value === 'LinearCurve' && typeof host.props.onChange === 'function';
  });
  assert.ok(typeSelect, 'function-type selector for the LinearCurve segment missing');
  typeSelect.props.onChange({ target: { value: 'ConstantFunctionCurve' } });
  tree = await settle();
  const retypedApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const retypedOp = retypedApplied.ops.find((op) => op.op === 'patch');
  assert.ok(retypedOp, 'type change did not emit a patch op');
  assert.deepEqual(retypedOp.path, ['holdLine']);
  assert.equal(retypedOp.value.type, 'GorgeFramework.ConstantFunctionCurve', 'a single-segment type change must not wrap in piecewise');
  assert.equal(retypedOp.value.fields.value, 0);

  // 5. Dragging a segment boundary changes its time and converts a plain curve.
  const typedGeometry = geometryForValue(retypedOp.value);
  curveApplyButton = await openCurvePanel();
  const canvas2 = curveCanvasHost();
  const typedBandY = typedGeometry.bandTop + typedGeometry.bandH / 2;
  canvas2.props.onPointerDown({
    clientX: typedGeometry.toX(1),
    clientY: typedBandY,
    pointerId: 11,
    button: 0,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: canvas2,
  });
  canvas2.props.onPointerMove({
    clientX: typedGeometry.toX(1.5),
    clientY: typedBandY,
    pointerId: 11,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: canvas2,
  });
  canvas2.props.onPointerUp({
    clientX: typedGeometry.toX(1.5),
    clientY: typedBandY,
    pointerId: 11,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: canvas2,
  });
  tree = await settle();
  const draggedApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const draggedOp = draggedApplied.ops.find((op) => op.op === 'patch');
  assert.ok(draggedOp, 'boundary drag did not emit a patch op');
  assert.equal(draggedOp.value.type, 'GorgeFramework.PiecewiseFunctionCurve', 'boundary drag on a plain curve must convert it');
  const draggedPieces = draggedOp.value.fields.functionPieces.items;
  assert.equal(draggedPieces.length, 1);
  assert.ok(Math.abs(draggedPieces[0].fields.endX - 1.5) < 1e-6, 'boundary drag did not update the segment end: ' + draggedPieces[0].fields.endX);
  assert.ok(Math.abs(draggedPieces[0].fields.startX + 1) < 1e-6, 'boundary drag changed the untouched start');

  // 6. Right-click creates a second segment with a chosen function type.
  const draggedGeometry = geometryForValue(draggedOp.value);
  curveApplyButton = await openCurvePanel();
  const canvas3 = curveCanvasHost();
  canvas3.props.onContextMenu({
    clientX: draggedGeometry.toX(0.25),
    clientY: draggedGeometry.plotTop + draggedGeometry.plotH / 2,
    preventDefault() {},
    stopPropagation() {},
    target: canvas3,
  });
  tree = await settle();
  const menuText = flattenText(tree, []).join(' ');
  assert.ok(menuText.includes('curveNewSegment'), 'right-click menu has no new-segment item');
  assert.ok(menuText.includes('curveChangeType'), 'right-click menu has no change-type item');
  assert.ok(menuText.includes('curveDeleteSegment'), 'right-click menu has no delete item');
  const newItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitem' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('curveNewSegment');
  });
  assert.ok(newItem, 'new-segment menu item missing');
  newItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: newItem });
  tree = await settle();
  const typeItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitemradio' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('ConstantFunctionCurve');
  });
  assert.ok(typeItem, 'the new-segment type list has no ConstantFunctionCurve item');
  typeItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: typeItem });
  tree = await settle();
  assert.equal(segmentRowHosts().length, 2, 'right-click did not create a second segment');
  const splitApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const splitOp = splitApplied.ops.find((op) => op.op === 'patch');
  assert.ok(splitOp, 'segment creation did not emit a patch op');
  assert.deepEqual(splitOp.path, ['holdLine']);
  assert.equal(splitOp.value.type, 'GorgeFramework.PiecewiseFunctionCurve');
  const splitPieces = splitOp.value.fields.functionPieces.items;
  assert.equal(splitPieces.length, 2);
  assert.equal(splitPieces[0].fields.endX, splitPieces[1].fields.startX, 'created pieces must share their boundary');
  assert.ok(Math.abs(splitPieces[0].fields.endX - 0.25) < 1e-6, 'right-click split did not land on the snapped time: ' + splitPieces[0].fields.endX);
  assert.equal(curveApi.curveTypeOf(splitPieces[1].fields.functionCurve), 'ConstantFunctionCurve');

  // 7. Right-click -> change type on an existing segment.
  const splitGeometry = geometryForValue(splitOp.value);
  curveApplyButton = await openCurvePanel();
  const canvas4 = curveCanvasHost();
  canvas4.props.onContextMenu({
    clientX: splitGeometry.toX(0.75),
    clientY: splitGeometry.plotTop + splitGeometry.plotH / 2,
    preventDefault() {},
    stopPropagation() {},
    target: canvas4,
  });
  tree = await settle();
  const changeItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitem' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('curveChangeType');
  });
  assert.ok(changeItem, 'change-type menu item missing');
  changeItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: changeItem });
  tree = await settle();
  const linearItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitemradio' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'LinearCurve';
  });
  assert.ok(linearItem, 'change-type list has no LinearCurve item');
  linearItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: linearItem });
  tree = await settle();
  const changedApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const changedOp = changedApplied.ops.find((op) => op.op === 'patch');
  assert.ok(changedOp, 'menu type change did not emit a patch op');
  const changedPieces = changedOp.value.fields.functionPieces.items;
  assert.equal(changedPieces.length, 2);
  assert.equal(curveApi.curveTypeOf(changedPieces[1].fields.functionCurve), 'LinearCurve');
  assert.equal(changedPieces[0].fields.endX, changedPieces[1].fields.startX);

  // 8. Right-click -> delete a segment; the remaining segment stays continuous.
  const changedGeometry = geometryForValue(changedOp.value);
  curveApplyButton = await openCurvePanel();
  const canvas5 = curveCanvasHost();
  canvas5.props.onContextMenu({
    clientX: changedGeometry.toX(-0.5),
    clientY: changedGeometry.plotTop + changedGeometry.plotH / 2,
    preventDefault() {},
    stopPropagation() {},
    target: canvas5,
  });
  tree = await settle();
  const deleteItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitem' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('curveDeleteSegment');
  });
  assert.ok(deleteItem, 'delete menu item missing');
  assert.ok(!deleteItem.props.disabled, 'delete must be enabled with two segments');
  deleteItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: deleteItem });
  tree = await settle();
  assert.equal(segmentRowHosts().length, 1, 'delete did not remove the segment');
  const deletedApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const deletedOp = deletedApplied.ops.find((op) => op.op === 'patch');
  assert.ok(deletedOp, 'segment delete did not emit a patch op');
  assert.equal(deletedOp.value.type, 'GorgeFramework.PiecewiseFunctionCurve', 'a piecewise root must stay piecewise after deleting a segment');
  const deletedPieces = deletedOp.value.fields.functionPieces.items;
  assert.equal(deletedPieces.length, 1);
  assert.ok(Math.abs(deletedPieces[0].fields.startX + 1) < 1e-6, 'delete did not transfer the absorbed start');
  assert.ok(Math.abs(deletedPieces[0].fields.endX - 1.5) < 1e-6, 'delete did not keep the remaining end');

  // 9. Right-click outside the covered range appends an adjacent segment.
  const deletedGeometry = geometryForValue(deletedOp.value);
  curveApplyButton = await openCurvePanel();
  const canvas6 = curveCanvasHost();
  canvas6.props.onContextMenu({
    clientX: deletedGeometry.toX(1.75),
    clientY: deletedGeometry.plotTop + deletedGeometry.plotH / 2,
    preventDefault() {},
    stopPropagation() {},
    target: canvas6,
  });
  tree = await settle();
  const outsideText = flattenText(tree, []).join(' ');
  assert.ok(outsideText.includes('curveNewSegmentAt'), 'outside right-click must offer an adjacent new segment');
  const outsideNewItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitem' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('curveNewSegment');
  });
  assert.ok(outsideNewItem, 'outside new-segment item missing');
  outsideNewItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: outsideNewItem });
  tree = await settle();
  const outsideTypeItem = findHost(tree, (host) => {
    if (!host.props || host.props.role !== 'menuitemradio' || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'ConstantFunctionCurve';
  });
  assert.ok(outsideTypeItem, 'outside type list has no ConstantFunctionCurve item');
  outsideTypeItem.props.onClick({ preventDefault() {}, stopPropagation() {}, target: outsideTypeItem });
  tree = await settle();
  const outsideApplied = await applyLastCurve(findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  }));
  const outsideOp = outsideApplied.ops.find((op) => op.op === 'patch');
  assert.ok(outsideOp, 'outside segment creation did not emit a patch op');
  const outsidePieces = outsideOp.value.fields.functionPieces.items;
  assert.equal(outsidePieces.length, 2);
  assert.equal(outsidePieces[0].fields.endX, outsidePieces[1].fields.startX);
  assert.ok(Math.abs(outsidePieces[1].fields.endX - 1.75) < 1e-6, 'outside segment did not reach the clicked time');

  // The outside Constant(0) segment creates a value jump against the linear
  // curve; the warning card must offer a one-click auto-fix that shifts the
  // right segment, and the fixed draft must apply cleanly.
  curveApplyButton = await openCurvePanel();
  tree = await settle();
  const outsideSegmentRows = segmentRowHosts();
  assert.ok(outsideSegmentRows.length >= 2, 'outside segment was not listed after reopening');
  outsideSegmentRows[1].props.onClick({ preventDefault() {}, stopPropagation() {}, target: outsideSegmentRows[1] });
  tree = await settle();
  const constantValueRow = findHost(
    tree,
    (host) => hasClassToken(host, 'dgc-field') && flattenText(host.rendered, []).join(' ').trim() === 'value',
  );
  assert.ok(constantValueRow, 'selected Constant segment has no value field');
  const constantValueInput = flattenHosts(constantValueRow.rendered, []).find((host) => host.tagName === 'INPUT');
  assert.ok(constantValueInput, 'Constant value input missing');
  constantValueInput.props.onChange({ target: { value: '999' } });
  constantValueInput.props.onBlur({ target: { value: '999' }, currentTarget: constantValueInput });
  tree = await settle();
  assert.ok(flattenText(tree, []).join(' ').includes('curveValueJump'), 'value-jump warning missing after editing the segment value');
  const autoFixButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').includes('curveAutoFix');
  });
  assert.ok(autoFixButton, 'value-jump warning has no auto-fix button');
  autoFixButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: autoFixButton });
  tree = await settle();
  assert.ok(!flattenText(tree, []).join(' ').includes('curveValueJump'), 'auto-fix did not clear the value-jump warning');
  const autoFixedApplyButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  });
  const autoFixedBatch = await applyLastCurve(autoFixedApplyButton);
  const autoFixedOp = autoFixedBatch && autoFixedBatch.ops && autoFixedBatch.ops.find((op) => op.op === 'patch');
  assert.ok(autoFixedOp, 'auto-fixed curve did not patch the element');
  const autoFixedPieces = autoFixedOp.value.fields.functionPieces.items;
  assert.equal(autoFixedPieces.length, 2, 'auto-fix changed the segment count');
  const fixedBoundary = autoFixedPieces[1].fields.startX;
  const fixedLeft = curveApi.sampleCurve(autoFixedPieces[0].fields.functionCurve, fixedBoundary);
  const fixedRight = curveApi.sampleCurve(autoFixedPieces[1].fields.functionCurve, fixedBoundary);
  assert.ok(Number.isFinite(fixedLeft) && Number.isFinite(fixedRight), 'auto-fixed boundary samples are not finite');
  assert.ok(Math.abs(fixedLeft - fixedRight) < 1e-6, 'auto-fix did not make the applied boundary continuous');
  assert.notEqual(autoFixedPieces[1].fields.functionCurve.fields.value, 999, 'auto-fix left the edited 999 value in place');
}

// 5a. Optional schema fields are switched on/off with checkboxes. Checking a
// missing field materialises a sensible default; unchecking removes the key
// again (a nested field disappears from its parent object, and a top-level
// field is removed through a whole-fields patch).
const colorToggle = findOptionalToggle(tree, 'color');
assert.ok(colorToggle, 'optional colour checkbox missing from the inspector');
if (isRealMode) {
  assert.equal(typeof colorToggle.props.checked, 'boolean', 'real optional colour checkbox has no state');
  // The real lane shows the same nested optional field the screenshot asks
  // for: VariableFloat.variationCurve gets a checkbox in its object editor.
  const laneRow = findClickableByText(tree, 'DremuMainLane');
  assert.ok(laneRow, 'real lane row not found');
  laneRow.props.onClick({ target: laneRow, stopPropagation() {}, preventDefault() {}, shiftKey: false, metaKey: false, ctrlKey: false });
  tree = await settle();
  const realVariationToggle = findOptionalToggle(tree, 'variationCurve');
  assert.ok(realVariationToggle, 'real lane variationCurve checkbox missing');
  assert.equal(typeof realVariationToggle.props.checked, 'boolean', 'real variationCurve checkbox has no state');
} else {
  assert.equal(colorToggle.props.checked, false, 'the fixture hold should start without a colour');
  colorToggle.props.onChange({ target: { checked: true } });
  tree = await settle();
  const colorBatch = editBodies[editBodies.length - 1];
  const colorOp = colorBatch && colorBatch.ops && colorBatch.ops.find((op) => op.op === 'patch');
  assert.ok(colorOp, 'checking the optional colour did not patch the element');
  assert.equal(colorOp.path[0], 'color', 'optional colour patch path');
  assert.equal(colorOp.value.type, 'GorgeFramework.LerpColorCurve', 'optional colour default type');
  assert.ok(
    colorOp.value.fields && colorOp.value.fields.colorPoints && colorOp.value.fields.colorPoints.items.length === 1,
    'optional colour default should contain one colour point',
  );
  const checkedColorToggle = findOptionalToggle(tree, 'color');
  assert.equal(checkedColorToggle.props.checked, true, 'optional colour checkbox did not turn on');
  checkedColorToggle.props.onChange({ target: { checked: false } });
  tree = await settle();
  const removeColorBatch = editBodies[editBodies.length - 1];
  const removeColorOp = removeColorBatch && removeColorBatch.ops && removeColorBatch.ops.find((op) => op.op === 'patch');
  assert.ok(removeColorOp, 'unchecking the optional colour did not patch the element');
  assert.equal(removeColorOp.path.length, 0, 'removing a top-level optional field should replace the fields map');
  assert.ok(!Object.prototype.hasOwnProperty.call(removeColorOp.value, 'color'), 'optional colour was not removed');
  const uncheckedColorToggle = findOptionalToggle(tree, 'color');
  assert.equal(uncheckedColorToggle.props.checked, false, 'optional colour checkbox did not turn off');

  // Nested optional field: VariableFloat.variationCurve on a tap's position.
  const tapRow = findClickableByText(tree, 'DremuTap');
  assert.ok(tapRow, 'DremuTap row not found');
  tapRow.props.onClick({ target: tapRow, stopPropagation() {}, preventDefault() {}, shiftKey: false, metaKey: false, ctrlKey: false });
  tree = await settle();
  assert.ok(
    findHost(
      tree,
      (host) =>
        hasClassToken(host, 'dgc-field') &&
        host.props &&
        host.props.style &&
        host.props.style.gridTemplateColumns === '72px minmax(0,1fr)',
    ),
    'nested object rows should use the compact 72px label column so their inputs stay usable',
  );
  const variationToggle = findOptionalToggle(tree, 'variationCurve');
  assert.ok(variationToggle, 'nested variationCurve checkbox missing');
  assert.equal(variationToggle.props.checked, false, 'the tap variationCurve should start unused');
  variationToggle.props.onChange({ target: { checked: true } });
  tree = await settle();
  const variationBatch = editBodies[editBodies.length - 1];
  const variationOp = variationBatch && variationBatch.ops && variationBatch.ops.find((op) => op.op === 'patch');
  assert.ok(variationOp, 'checking the nested variationCurve did not patch the element');
  assert.equal(variationOp.path[0], 'position', 'nested variationCurve patch path');
  const variationValue = variationOp.value.fields.variationCurve;
  assert.equal(variationValue.type, 'GorgeFramework.LinearCurve', 'variationCurve default type');
  assert.equal(variationValue.fields.valueStart, 0, 'variationCurve should start at zero');
  assert.equal(variationValue.fields.valueEnd, 0, 'variationCurve should stay flat at zero');
  assert.equal(variationOp.value.fields.baseValue, -1, 'adding variationCurve must preserve baseValue');
  const checkedVariationToggle = findOptionalToggle(tree, 'variationCurve');
  assert.equal(checkedVariationToggle.props.checked, true, 'nested variationCurve checkbox did not turn on');
  const nestedCurveButton = findHost(
    tree,
    (host) => host.props && host.props.title === 'curveEditor' && typeof host.props.onClick === 'function',
  );
  assert.ok(nestedCurveButton, 'nested variationCurve has no curve-editor button');
  nestedCurveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: nestedCurveButton });
  tree = await settle();
  // Change valueEnd in the sidebar: the nested apply must persist the value,
  // not a stray property beside the typed object's `fields` map.
  const valueEndRow = findHost(
    tree,
    (host) =>
      hasClassToken(host, 'dgc-field') &&
      flattenText(host.rendered, []).join(' ').indexOf('valueEnd') !== -1,
  );
  assert.ok(valueEndRow, 'curve panel has no valueEnd row');
  const valueEndInput = flattenHosts(valueEndRow.rendered, []).find((host) => host.tagName === 'INPUT');
  assert.ok(valueEndInput, 'curve panel valueEnd input missing');
  valueEndInput.props.onChange({ target: { value: '0.5' } });
  valueEndInput.props.onBlur({ target: { value: '0.5' }, currentTarget: valueEndInput });
  tree = await settle();
  const nestedApplyButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  });
  const nestedApplyBatch = await applyLastCurve(nestedApplyButton);
  const nestedApplyOp = nestedApplyBatch && nestedApplyBatch.ops && nestedApplyBatch.ops.find((op) => op.op === 'patch');
  assert.ok(nestedApplyOp, 'applying a nested curve did not patch the element');
  assert.deepEqual(
    nestedApplyOp.path,
    ['position', 'fields', 'variationCurve'],
    'nested curve apply must patch its exact fields path',
  );
  assert.equal(nestedApplyOp.value.type, 'GorgeFramework.LinearCurve', 'nested curve apply value type');
  assert.equal(nestedApplyOp.value.fields.valueEnd, 0.5, 'nested curve edit was not in the patch value');
  const afterNestedApplyToggle = findOptionalToggle(tree, 'variationCurve');
  assert.equal(afterNestedApplyToggle.props.checked, true, 'nested variationCurve vanished after its panel applied');
  // Reopen the panel: it must read the edited value from the parent object.
  const reopenCurveButton = findHost(
    tree,
    (host) => host.props && host.props.title === 'curveEditor' && typeof host.props.onClick === 'function',
  );
  assert.ok(reopenCurveButton, 'nested curve button missing after apply');
  reopenCurveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: reopenCurveButton });
  tree = await settle();
  const reopenedEndRow = findHost(
    tree,
    (host) =>
      hasClassToken(host, 'dgc-field') &&
      flattenText(host.rendered, []).join(' ').indexOf('valueEnd') !== -1,
  );
  assert.ok(reopenedEndRow, 'reopened curve panel has no valueEnd row');
  const reopenedEndInput = flattenHosts(reopenedEndRow.rendered, []).find((host) => host.tagName === 'INPUT');
  assert.ok(reopenedEndInput, 'reopened curve panel valueEnd input missing');
  assert.ok(Math.abs(Number(reopenedEndInput.props.value) - 0.5) < 1e-9, 'reopened curve lost the applied value');
  const cancelReopenedCurve = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'cancel';
  });
  assert.ok(cancelReopenedCurve, 'reopened curve panel has no cancel button');
  cancelReopenedCurve.props.onClick({ preventDefault() {}, stopPropagation() {}, target: cancelReopenedCurve });
  tree = await settle();
  const afterReopenToggle = findOptionalToggle(tree, 'variationCurve');
  assert.equal(afterReopenToggle.props.checked, true, 'variationCurve checkbox changed after reopen/cancel');
  afterReopenToggle.props.onChange({ target: { checked: false } });
  tree = await settle();
  const removeVariationBatch = editBodies[editBodies.length - 1];
  const removeVariationOp = removeVariationBatch && removeVariationBatch.ops && removeVariationBatch.ops.find((op) => op.op === 'patch');
  assert.ok(removeVariationOp, 'unchecking the nested variationCurve did not patch the element');
  assert.equal(removeVariationOp.path[0], 'position', 'nested variationCurve removal path');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(removeVariationOp.value.fields, 'variationCurve'),
    'nested variationCurve was not removed',
  );
  assert.equal(removeVariationOp.value.fields.baseValue, -1, 'removing variationCurve must preserve baseValue');
  assert.equal(findOptionalToggle(tree, 'variationCurve').props.checked, false, 'nested variationCurve checkbox did not turn off');
  // Curves inside arrays (laneLines and friends) are editable too: the item
  // card is not collapsed and its curve button patches the array item path.
  const arrayCurveButton = findHost(
    tree,
    (host) => host.props && host.props.title === 'curveEditor' && typeof host.props.onClick === 'function',
  );
  assert.ok(arrayCurveButton, 'curve inside an array has no curve button');
  arrayCurveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: arrayCurveButton });
  tree = await settle();
  const arrayApplyButton = findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').trim() === 'apply';
  });
  const arrayApplyBatch = await applyLastCurve(arrayApplyButton);
  const arrayApplyOp = arrayApplyBatch && arrayApplyBatch.ops && arrayApplyBatch.ops.find((op) => op.op === 'patch');
  assert.ok(arrayApplyOp, 'array curve apply did not patch the element');
  assert.deepEqual(arrayApplyOp.path, ['curves', 'items', 0], 'array curve apply must patch the item path');
  assert.equal(arrayApplyOp.value.type, 'GorgeFramework.LinearCurve', 'array curve apply value type');
}

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
console.log('            inspector fields, docked curve panel (beat grid + segments + type/parameter editors),');
console.log('            curve Apply / right-click segment creation / type change / delete / boundary drag,');
console.log('            apply/undo/save round trips,');
console.log('            note drag -> patch(hitTime), undo -> inverse patch, redo, tap placement -> add op,');
console.log('            addStaff dialog -> addStaff op (chart + storyboard), the element palette -> add op,');
console.log('            the staff right-click menu -> setStaffName / removeStaff(deleteFile) ops,');
console.log('            the audio-period dialog -> addAudioPeriod / clip drag -> patchAudioPeriod ops,');
console.log('            the audio-strip right-click menu -> waveform/spectrum mode,');
console.log('            and auto-BPM detection -> setMeta.tempo.');
