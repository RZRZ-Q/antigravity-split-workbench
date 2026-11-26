/**
 * Pure Binary Space Partitioning (BSP) Auto-Split Layout Engine.
 * Works in both browser (window.SplitLayout) and Node.js ESM/CJS tests.
 *
 * Conventions:
 * - direction === 'horizontal' => side-by-side (left | right)
 * - direction === 'vertical'   => stacked (top / bottom)
 */
(function (rootScope) {
  let idCounter = 1;

  function genId(prefix) {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }

  function createLeaf(paneType = 'empty', state = {}, id = null) {
    return {
      type: 'leaf',
      id: id || genId('pane'),
      paneType,
      state: { ...state },
    };
  }

  /**
   * Smart auto-split decision (Claude Desktop / tiling WM style):
   * - Wide pane (width > height * 1.1) => horizontal split (left | right)
   * - Tall or square pane              => vertical split   (top / bottom)
   */
  function decideSplitDirection(rect, mode = 'auto') {
    if (mode === 'horizontal' || mode === 'vertical') return mode;
    if (!rect || rect.width <= 0 || rect.height <= 0) return 'horizontal';
    return rect.width > rect.height * 1.1 ? 'horizontal' : 'vertical';
  }

  function clampRatio(ratio) {
    const r = Number(ratio);
    if (!Number.isFinite(r)) return 0.5;
    return Math.min(0.85, Math.max(0.15, r));
  }

  function findLeaf(node, id) {
    if (!node) return null;
    if (node.type === 'leaf') return node.id === id ? node : null;
    return findLeaf(node.first, id) || findLeaf(node.second, id);
  }

  function findSplit(node, id) {
    if (!node || node.type === 'leaf') return null;
    if (node.id === id) return node;
    return findSplit(node.first, id) || findSplit(node.second, id);
  }

  function findParentSplit(node, targetId) {
    if (!node || node.type === 'leaf') return null;
    if (node.first?.id === targetId || node.second?.id === targetId) return node;
    return findParentSplit(node.first, targetId) || findParentSplit(node.second, targetId);
  }

  function toggleSplitDirection(root, splitId) {
    if (!root || root.type === 'leaf') return root;
    function walk(node) {
      if (node.type === 'leaf') return node;
      if (node.id === splitId) {
        return {
          ...node,
          direction: node.direction === 'horizontal' ? 'vertical' : 'horizontal',
        };
      }
      const nextFirst = walk(node.first);
      if (nextFirst !== node.first) return { ...node, first: nextFirst };
      const nextSecond = walk(node.second);
      if (nextSecond !== node.second) return { ...node, second: nextSecond };
      return node;
    }
    return walk(root);
  }

  function toggleLeafSplitDirection(root, leafId) {
    const parent = findParentSplit(root, leafId);
    if (!parent) return root;
    return toggleSplitDirection(root, parent.id);
  }

  function listLeaves(node, out = []) {
    if (!node) return out;
    if (node.type === 'leaf') {
      out.push(node);
    } else {
      listLeaves(node.first, out);
      listLeaves(node.second, out);
    }
    return out;
  }

  function countLeaves(node) {
    return listLeaves(node).length;
  }

  function findLeafByPredicate(node, predicate) {
    const leaves = listLeaves(node);
    return leaves.find(predicate) || null;
  }

  function splitLeaf(root, targetId, newLeaf, direction = 'horizontal', ratio = 0.5) {
    if (!root) return newLeaf;
    const dir = direction === 'vertical' ? 'vertical' : 'horizontal';
    const r = clampRatio(ratio);

    function walk(node) {
      if (node.type === 'leaf') {
        if (node.id === targetId) {
          return {
            type: 'split',
            id: genId('split'),
            direction: dir,
            ratio: r,
            first: node,
            second: newLeaf,
          };
        }
        return node;
      }
      const nextFirst = walk(node.first);
      if (nextFirst !== node.first) {
        return { ...node, first: nextFirst };
      }
      const nextSecond = walk(node.second);
      if (nextSecond !== node.second) {
        return { ...node, second: nextSecond };
      }
      return node;
    }

    const updated = walk(root);
    // Fallback: if targetId wasn't found, split the root itself
    if (updated === root) {
      return {
        type: 'split',
        id: genId('split'),
        direction: dir,
        ratio: r,
        first: root,
        second: newLeaf,
      };
    }
    return updated;
  }

  function replaceLeaf(root, targetId, paneType, state = {}) {
    if (!root) return createLeaf(paneType, state);
    function walk(node) {
      if (node.type === 'leaf') {
        if (node.id === targetId) {
          return { ...node, paneType, state: { ...state } };
        }
        return node;
      }
      const nextFirst = walk(node.first);
      const nextSecond = walk(node.second);
      if (nextFirst === node.first && nextSecond === node.second) return node;
      return { ...node, first: nextFirst, second: nextSecond };
    }
    return walk(root);
  }

  function updateLeafState(root, targetId, patch) {
    if (!root) return root;
    function walk(node) {
      if (node.type === 'leaf') {
        if (node.id === targetId) {
          return { ...node, state: { ...node.state, ...patch } };
        }
        return node;
      }
      const nextFirst = walk(node.first);
      const nextSecond = walk(node.second);
      if (nextFirst === node.first && nextSecond === node.second) return node;
      return { ...node, first: nextFirst, second: nextSecond };
    }
    return walk(root);
  }

  function removeLeaf(root, targetId) {
    if (!root) return { root: null, nextActiveId: null };
    if (root.type === 'leaf') {
      if (root.id === targetId) return { root: null, nextActiveId: null };
      return { root, nextActiveId: root.id };
    }

    let promotedSibling = null;

    function walk(node) {
      if (node.type === 'leaf') return node;
      if (node.first.type === 'leaf' && node.first.id === targetId) {
        promotedSibling = node.second;
        return node.second;
      }
      if (node.second.type === 'leaf' && node.second.id === targetId) {
        promotedSibling = node.first;
        return node.first;
      }
      const nextFirst = walk(node.first);
      if (nextFirst !== node.first) return { ...node, first: nextFirst };
      const nextSecond = walk(node.second);
      if (nextSecond !== node.second) return { ...node, second: nextSecond };
      return node;
    }

    const nextRoot = walk(root);
    const siblingLeaves = promotedSibling ? listLeaves(promotedSibling) : listLeaves(nextRoot);
    const nextActiveId = siblingLeaves.length > 0 ? siblingLeaves[0].id : null;
    return { root: nextRoot, nextActiveId };
  }

  function swapLeaves(root, idA, idB) {
    if (!root || !idA || !idB || idA === idB) return root;
    const leafA = findLeaf(root, idA);
    const leafB = findLeaf(root, idB);
    if (!leafA || !leafB) return root;

    function walk(node) {
      if (node.type === 'leaf') {
        if (node.id === idA) return leafB;
        if (node.id === idB) return leafA;
        return node;
      }
      return { ...node, first: walk(node.first), second: walk(node.second) };
    }
    return walk(root);
  }

  function updateSplitRatio(root, splitId, ratio) {
    if (!root) return root;
    const r = clampRatio(ratio);
    function walk(node) {
      if (node.type === 'leaf') return node;
      if (node.id === splitId) {
        return { ...node, ratio: r };
      }
      const nextFirst = walk(node.first);
      if (nextFirst !== node.first) return { ...node, first: nextFirst };
      const nextSecond = walk(node.second);
      if (nextSecond !== node.second) return { ...node, second: nextSecond };
      return node;
    }
    return walk(root);
  }

  function resetAllRatios(root) {
    if (!root || root.type === 'leaf') return root;
    return {
      ...root,
      ratio: 0.5,
      first: resetAllRatios(root.first),
      second: resetAllRatios(root.second),
    };
  }

  /**
   * Computes exact pixel rectangles for every leaf and every split divider gutter
   * within a stage of size (stageW, stageH).
   * Flat absolute positioning keeps leaf DOM nodes mounted across splits & swaps
   * so iframes never reload and PTY xterm instances never detach!
   */
  function computeGeometry(root, stageW, stageH, gap = 6) {
    const leaves = new Map(); // leafId -> { x, y, w, h, leaf }
    const gutters = [];       // [{ id, direction, x, y, w, h, parentRect }]
    if (!root || stageW <= 0 || stageH <= 0) return { leaves, gutters };

    function visit(node, x, y, w, h) {
      if (node.type === 'leaf') {
        leaves.set(node.id, { x, y, w: Math.max(0, w), h: Math.max(0, h), leaf: node });
        return;
      }
      const r = clampRatio(node.ratio);
      if (node.direction === 'horizontal') {
        const usableW = Math.max(0, w - gap);
        const w1 = Math.round(usableW * r);
        const w2 = Math.max(0, usableW - w1);
        gutters.push({
          id: node.id,
          direction: 'horizontal',
          x: x + w1,
          y,
          w: gap,
          h,
          parentRect: { x, y, w, h },
        });
        visit(node.first, x, y, w1, h);
        visit(node.second, x + w1 + gap, y, w2, h);
      } else {
        const usableH = Math.max(0, h - gap);
        const h1 = Math.round(usableH * r);
        const h2 = Math.max(0, usableH - h1);
        gutters.push({
          id: node.id,
          direction: 'vertical',
          x,
          y: y + h1,
          w,
          h: gap,
          parentRect: { x, y, w, h },
        });
        visit(node.first, x, y, w, h1);
        visit(node.second, x, y + h1 + gap, w, h2);
      }
    }

    visit(root, 0, 0, stageW, stageH);
    return { leaves, gutters };
  }

  /**
   * Sanitizes a persisted layout tree before restoring (drops broken nodes,
   * ensures unique IDs and valid pane types).
   */
  function sanitizeTree(node, seenIds = new Set()) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'leaf') {
      const validTypes = new Set(['file', 'web', 'terminal', 'artifact', 'empty']);
      const paneType = validTypes.has(node.paneType) ? node.paneType : 'empty';
      let id = typeof node.id === 'string' && node.id ? node.id : genId('pane');
      if (seenIds.has(id)) id = genId('pane');
      seenIds.add(id);
      const state = node.state && typeof node.state === 'object' ? { ...node.state } : {};
      return { type: 'leaf', id, paneType, state };
    }
    if (node.type === 'split') {
      const first = sanitizeTree(node.first, seenIds);
      const second = sanitizeTree(node.second, seenIds);
      if (!first && !second) return null;
      if (!first) return second;
      if (!second) return first;
      let id = typeof node.id === 'string' && node.id ? node.id : genId('split');
      if (seenIds.has(id)) id = genId('split');
      seenIds.add(id);
      return {
        type: 'split',
        id,
        direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
        ratio: clampRatio(node.ratio),
        first,
        second,
      };
    }
    return null;
  }

  const api = {
    createLeaf,
    decideSplitDirection,
    clampRatio,
    findLeaf,
    findSplit,
    findParentSplit,
    listLeaves,
    countLeaves,
    findLeafByPredicate,
    splitLeaf,
    replaceLeaf,
    updateLeafState,
    removeLeaf,
    swapLeaves,
    updateSplitRatio,
    toggleSplitDirection,
    toggleLeafSplitDirection,
    resetAllRatios,
    computeGeometry,
    sanitizeTree,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    rootScope.SplitLayout = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
