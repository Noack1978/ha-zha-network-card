/*!
 * ha-zha-network-card
 * Lovelace custom card that draws the ZHA Zigbee mesh (coordinator, routers,
 * end devices and their LQI-rated links) without relying on the deprecated
 * /config/zha/visualization settings page.
 *
 * Data source: the built-in ZHA websocket commands "zha/devices" and
 * "zha/topology/update" (home-assistant/core homeassistant/components/zha).
 * No custom backend / custom_component is required.
 *
 * https://github.com/Noack1978/ha-zha-network-card
 */

const CARD_VERSION = "1.4.0";

// LQI thresholds, matching the historic dmulcahey/zha-network-visualization-card
// convention that Mirko's HA users are already used to.
const LQI_GREEN = 192;
const LQI_YELLOW = 129;

function lqiColor(lqi) {
  const v = Number(lqi);
  if (Number.isNaN(v) || v <= 0) return "#5c5c5c";
  if (v > LQI_GREEN) return "#2fb350";
  if (v >= LQI_YELLOW) return "#d8a300";
  return "#d8453a";
}

function deviceKind(device) {
  if (device.active_coordinator) return "coordinator";
  const t = (device.device_type || "").toString().toLowerCase();
  if (t.includes("router")) return "router";
  if (t.includes("end")) return "end_device";
  // Fallback: mains-powered devices act as routers, battery devices are end devices
  return (device.power_source || "").toLowerCase().includes("mains")
    ? "router"
    : "end_device";
}

class ZhaNetworkCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._initialized = false;
    this._nodes = [];
    this._edges = [];
    this._nodeById = new Map();
    this._scale = 1;
    this._offset = { x: 0, y: 0 };
    this._drag = null;
    this._selected = null;
    this._refreshTimer = null;
    this._lastFetch = 0;
  }

  setConfig(config) {
    this._config = {
      title: config.title ?? "ZHA Netzwerk",
      refresh_interval: config.refresh_interval ?? 60,
      rescan_on_load: config.rescan_on_load ?? false,
      show_end_devices: config.show_end_devices ?? true,
      height: config.height ?? 560,
      ...config,
    };
  }

  // Called by Lovelace very frequently (on every state change). Per HA card
  // best practice we must NOT re-render on every call - only stash the
  // reference and render once on first arrival.
  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._startAutoRefresh();
      this._fetchData(this._config.rescan_on_load);
    }
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return Math.ceil((this._config?.height ?? 480) / 50);
  }

  disconnectedCallback() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    window.removeEventListener("resize", this._onResize);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  _startAutoRefresh() {
    const seconds = Number(this._config.refresh_interval) || 0;
    if (seconds <= 0) return;
    this._refreshTimer = setInterval(() => {
      this._fetchData(false);
    }, seconds * 1000);
  }

  _render() {
    const height = this._config.height;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          overflow: hidden;
          position: relative;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px 0 16px;
        }
        .header h1 {
          font-size: 1.2em;
          font-weight: 500;
          margin: 0;
          color: var(--ha-card-header-color, var(--primary-text-color));
        }
        .toolbar {
          display: flex;
          gap: 4px;
        }
        button.icon-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--secondary-text-color);
          padding: 6px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        button.icon-btn:hover {
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
          color: var(--primary-text-color);
        }
        .canvas-wrap {
          position: relative;
          width: 100%;
          height: ${height}px;
          touch-action: none;
        }
        canvas {
          width: 100%;
          height: 100%;
          display: block;
          cursor: grab;
        }
        canvas:active { cursor: grabbing; }
        .legend {
          position: absolute;
          left: 12px;
          bottom: 8px;
          font-size: 0.72em;
          color: var(--secondary-text-color);
          display: flex;
          gap: 14px;
          flex-wrap: wrap;
          pointer-events: none;
          background: var(--card-background-color, rgba(0,0,0,0.0));
        }
        .legend span { display: flex; align-items: center; gap: 4px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .line { width: 16px; height: 2px; display: inline-block; }
        .info-box {
          position: absolute;
          top: 8px;
          right: 8px;
          max-width: 260px;
          background: var(--card-background-color, #1c1c1c);
          border: 1px solid var(--divider-color, #333);
          border-radius: 8px;
          padding: 10px 28px 10px 12px;
          font-size: 0.82em;
          color: var(--primary-text-color);
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          display: none;
        }
        .info-box.visible { display: block; }
        .info-close {
          position: absolute;
          top: 4px;
          right: 6px;
          background: none;
          border: none;
          color: var(--secondary-text-color);
          font-size: 1.1em;
          line-height: 1;
          cursor: pointer;
          padding: 4px;
        }
        .info-close:hover { color: var(--primary-text-color); }
        .info-box .row { display: flex; justify-content: space-between; gap: 12px; margin: 2px 0; }
        .info-box .row b { color: var(--secondary-text-color); font-weight: 400; }
        .info-box .name { font-weight: 600; margin-bottom: 6px; font-size: 1em; }
        .status {
          position: absolute;
          left: 12px;
          top: 8px;
          font-size: 0.75em;
          color: var(--secondary-text-color);
          background: var(--card-background-color, rgba(28,28,28,0.85));
          padding: 2px 8px;
          border-radius: 10px;
          pointer-events: none;
        }
        .empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--secondary-text-color);
          font-size: 0.9em;
          text-align: center;
          padding: 0 24px;
        }
      </style>
      <ha-card>
        <div class="header">
          <h1>${this._config.title}</h1>
          <div class="toolbar">
            <button class="icon-btn" id="rescan" title="Neuen Netzwerk-Scan anstoßen">⟳</button>
            <button class="icon-btn" id="zoom-reset" title="Ansicht zurücksetzen">⤢</button>
          </div>
        </div>
        <div class="canvas-wrap">
          <canvas></canvas>
          <div class="status" id="status"></div>
          <div class="info-box" id="info">
            <button class="info-close" id="info-close" title="Schließen">×</button>
            <div id="info-content"></div>
          </div>
          <div class="legend">
            <span><span class="dot" style="background:#2fb350"></span> LQI &gt; ${LQI_GREEN}</span>
            <span><span class="dot" style="background:#d8a300"></span> LQI ${LQI_YELLOW}-${LQI_GREEN}</span>
            <span><span class="dot" style="background:#d8453a"></span> LQI &lt; ${LQI_YELLOW}</span>
          </div>
        </div>
      </ha-card>
    `;

    this._canvas = this.shadowRoot.querySelector("canvas");
    this._ctx = this._canvas.getContext("2d");
    this._statusEl = this.shadowRoot.getElementById("status");
    this._infoBox = this.shadowRoot.getElementById("info");
    this._infoEl = this.shadowRoot.getElementById("info-content");
    this.shadowRoot.getElementById("info-close").addEventListener("click", () => {
      this._closeInfo();
    });

    this.shadowRoot.getElementById("rescan").addEventListener("click", () => {
      this._fetchData(true);
    });
    this.shadowRoot.getElementById("zoom-reset").addEventListener("click", () => {
      this._scale = 1;
      this._offset = { x: 0, y: 0 };
      this._draw();
    });

    this._onResize = () => this._resizeCanvas();
    window.addEventListener("resize", this._onResize);

    // type: sections (and other lazily-laid-out dashboards) often report
    // 0x0 for the card container on first paint, before the section grid
    // has settled. A ResizeObserver catches the real size as soon as the
    // layout stabilizes, instead of relying only on window resize events.
    if ("ResizeObserver" in window) {
      this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
      this._resizeObserver.observe(this._canvas.parentElement);
    }

    this._resizeCanvas();
    this._attachPointerEvents();
  }

  _resizeCanvas() {
    if (!this._canvas) return;
    const wrap = this._canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      // Not laid out yet - try again on the next frame instead of drawing
      // into a near-zero-size canvas.
      requestAnimationFrame(() => this._resizeCanvas());
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = Math.max(1, rect.width * dpr);
    this._canvas.height = Math.max(1, rect.height * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sizeChanged = rect.width !== this._cssWidth || rect.height !== this._cssHeight;
    this._cssWidth = rect.width;
    this._cssHeight = rect.height;
    // If we already had a layout (data was fetched while the canvas was
    // still 0x0), re-run the force layout now that we know the real size.
    if (sizeChanged && this._nodes.length) {
      this._layout();
    }
    this._draw();
  }

  _attachPointerEvents() {
    const canvas = this._canvas;
    let panning = false;
    let last = null;
    const activePointers = new Map();

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      const newScale = Math.min(3, Math.max(0.3, this._scale * (1 + delta)));
      this._scale = newScale;
      this._draw();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);

      const hit = this._hitTest(e);
      if (hit) {
        this._selected = hit;
        this._showInfo(hit);
        this._draw();
        return;
      }
      if (this._selected) {
        this._closeInfo();
      }
      panning = true;
      last = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (!panning || !last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this._offset.x += dx;
      this._offset.y += dy;
      this._draw();
    });

    const endPointer = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        panning = false;
        last = null;
      }
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", endPointer);

    // --- Touch-event fallback for pinch-zoom -------------------------------
    // Some Android WebViews (incl. the HA Companion App) don't reliably
    // deliver a second simultaneous Pointer Event stream, so pinch-to-zoom
    // via pointerdown/pointermove above can silently do nothing. Touch
    // events expose all active touches directly via e.touches and work
    // consistently there, so we handle pinch-zoom through them as well.
    let touchPinchDist = null;
    let touchPinchScale = 1;
    let touchPanLast = null;

    const touchDist = (touches) =>
      Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );

    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        touchPinchDist = touchDist(e.touches) || 1;
        touchPinchScale = this._scale;
        touchPanLast = null;
      } else if (e.touches.length === 1) {
        const hit = this._hitTest(e.touches[0]);
        if (hit) {
          this._selected = hit;
          this._showInfo(hit);
          this._draw();
          touchPanLast = null;
          return;
        }
        if (this._selected) {
          this._closeInfo();
        }
        touchPanLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && touchPinchDist) {
        e.preventDefault();
        const dist = touchDist(e.touches) || 1;
        this._scale = Math.min(3, Math.max(0.3, touchPinchScale * (dist / touchPinchDist)));
        this._draw();
      } else if (e.touches.length === 1 && touchPanLast) {
        e.preventDefault();
        const dx = e.touches[0].clientX - touchPanLast.x;
        const dy = e.touches[0].clientY - touchPanLast.y;
        touchPanLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this._offset.x += dx;
        this._offset.y += dy;
        this._draw();
      }
    }, { passive: false });

    const touchEnd = (e) => {
      if (e.touches.length < 2) touchPinchDist = null;
      if (e.touches.length === 0) touchPanLast = null;
    };
    canvas.addEventListener("touchend", touchEnd);
    canvas.addEventListener("touchcancel", touchEnd);
  }

  _hitTest(e) {
    if (!this._nodes.length) return null;
    const rect = this._canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this._offset.x - this._cssWidth / 2) / this._scale + this._cssWidth / 2;
    const y = (e.clientY - rect.top - this._offset.y - this._cssHeight / 2) / this._scale + this._cssHeight / 2;
    let closest = null;
    let closestDist = Infinity;
    for (const n of this._nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 6 && d < closestDist) {
        closest = n;
        closestDist = d;
      }
    }
    return closest;
  }

  _showInfo(node) {
    const d = node.device;
    const lines = [
      ["Hersteller", d.manufacturer || "—"],
      ["Modell", d.model || "—"],
      ["IEEE", d.ieee || "—"],
      ["NWK", d.nwk ?? "—"],
      ["LQI", d.lqi ?? "—"],
      ["RSSI", d.rssi ?? "—"],
      ["Stromquelle", d.power_source || "—"],
      ["Online", d.available ? "Ja" : "Nein"],
      ["Zuletzt gesehen", d.last_seen || "—"],
    ];
    const technicalName = d.name || d.ieee;
    const showTechnical = node.displayName && node.displayName !== technicalName;
    this._infoEl.innerHTML =
      `<div class="name">${node.displayName || technicalName}</div>` +
      (showTechnical ? `<div class="row"><b>ZHA-Name</b><span>${technicalName}</span></div>` : "") +
      lines.map(([k, v]) => `<div class="row"><b>${k}</b><span>${v}</span></div>`).join("");
    this._infoBox.classList.add("visible");
  }

  _closeInfo() {
    this._selected = null;
    this._infoBox.classList.remove("visible");
    this._draw();
  }

  async _fetchData(forceRescan) {
    if (!this._hass) return;
    try {
      this._setStatus(forceRescan ? "Scanne Netzwerk …" : "Lade …");
      if (forceRescan) {
        await this._hass.callWS({ type: "zha/topology/update" });
        // The scan runs in the background on the ZHA gateway; give it a
        // few seconds before re-reading "zha/devices" so the freshly
        // gathered neighbor/route tables are populated.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const [devices, friendlyNames] = await Promise.all([
        this._hass.callWS({ type: "zha/devices" }),
        this._fetchFriendlyNameMap(),
      ]);
      this._buildGraph(devices || [], friendlyNames);
      this._lastFetch = Date.now();
      this._setStatus(`Aktualisiert: ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.error("zha-network-card: failed to load ZHA data", err);
      this._setStatus("Fehler beim Laden der ZHA-Daten (Admin-Rechte erforderlich)");
    }
  }

  // Builds a map of entity_id -> friendly device name by explicitly querying
  // HA's device and entity registries over the websocket API. We do this
  // ourselves rather than relying on hass.devices/hass.entities, since those
  // dictionaries are only populated once *something else* in the frontend
  // has subscribed to the registries - not guaranteed for a standalone card.
  async _fetchFriendlyNameMap() {
    try {
      const [devices, entities] = await Promise.all([
        this._hass.callWS({ type: "config/device_registry/list" }),
        this._hass.callWS({ type: "config/entity_registry/list" }),
      ]);
      const deviceNameById = new Map();
      for (const dev of devices || []) {
        const name = dev.name_by_user || dev.name;
        if (name) deviceNameById.set(dev.id, name);
      }
      const nameByEntityId = new Map();
      for (const ent of entities || []) {
        const name = deviceNameById.get(ent.device_id);
        if (name) nameByEntityId.set(ent.entity_id, name);
      }
      return nameByEntityId;
    } catch (err) {
      console.warn("zha-network-card: could not load device/entity registry for friendly names", err);
      return new Map();
    }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _buildGraph(devices, friendlyNames) {
    const showEnd = this._config.show_end_devices;
    const nodes = [];
    const nodeById = new Map();

    const resolveName = (device) => {
      for (const ent of device.entities || []) {
        const entityId = ent.entity_id || ent.ha_entity_id;
        const name = entityId && friendlyNames ? friendlyNames.get(entityId) : null;
        if (name) return name;
      }
      return null;
    };

    for (const device of devices) {
      const kind = deviceKind(device);
      if (!showEnd && kind === "end_device") continue;
      const node = {
        id: device.ieee,
        device,
        kind,
        displayName: resolveName(device) || device.name || device.ieee,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: kind === "coordinator" ? 22 : kind === "router" ? 16 : 11,
      };
      nodes.push(node);
      nodeById.set(device.ieee, node);
    }

    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const edgeMap = new Map();

    for (const device of devices) {
      const fromNode = nodeById.get(device.ieee);
      if (!fromNode) continue;
      for (const neighbor of device.neighbors || []) {
        const toNode = nodeById.get(neighbor.ieee);
        if (!toNode || toNode === fromNode) continue;
        const key = edgeKey(fromNode.id, toNode.id);
        const lqi = Number(neighbor.lqi) || 0;
        const existing = edgeMap.get(key);
        if (!existing || lqi > existing.lqi) {
          edgeMap.set(key, { a: fromNode, b: toNode, lqi });
        }
      }
    }

    this._nodes = nodes;
    this._edges = Array.from(edgeMap.values());
    this._nodeById = nodeById;

    if (!nodes.length) {
      this._draw();
      return;
    }

    this._layout();
    this._draw();
  }

  // Radial tree layout: coordinator at the center, every other device placed
  // on a ring whose radius is its Zigbee hop-distance (BFS depth) from the
  // coordinator. Siblings split their parent's angular sector. This mirrors
  // how the original zha-network-visualization-card looked (coordinator
  // center, routers/end-devices radiating outward) and produces far fewer
  // crossing lines than a general force-directed layout, since the strongest
  // links naturally become the tree edges.
  _layout() {
    const nodes = this._nodes;
    const edges = this._edges;
    const width = Math.max(300, this._cssWidth || 600);
    const height = Math.max(200, this._cssHeight || 400);
    const cx = width / 2;
    const cy = height / 2;

    const coordinator =
      nodes.find((n) => n.kind === "coordinator") || nodes[0];

    // Adjacency list, strongest link first, used both to build the BFS tree
    // and to prefer strong-LQI links as the "parent" connection.
    const adjacency = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      adjacency.get(e.a.id)?.push({ node: e.b, lqi: e.lqi });
      adjacency.get(e.b.id)?.push({ node: e.a, lqi: e.lqi });
    }
    for (const list of adjacency.values()) {
      list.sort((a, b) => b.lqi - a.lqi);
    }

    const parent = new Map();
    const depth = new Map();
    const children = new Map(nodes.map((n) => [n.id, []]));
    const visited = new Set();

    const bfsFrom = (root) => {
      const queue = [root];
      visited.add(root.id);
      depth.set(root.id, 0);
      while (queue.length) {
        const current = queue.shift();
        for (const { node: nb } of adjacency.get(current.id) || []) {
          if (visited.has(nb.id)) continue;
          visited.add(nb.id);
          parent.set(nb.id, current.id);
          depth.set(nb.id, depth.get(current.id) + 1);
          children.get(current.id).push(nb);
          queue.push(nb);
        }
      }
    };

    bfsFrom(coordinator);
    // Any devices not reachable from the coordinator (no recorded neighbor
    // path yet, e.g. right after pairing) get attached as virtual children
    // of the coordinator so they still get a sensible ring position.
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        visited.add(n.id);
        depth.set(n.id, 1);
        parent.set(n.id, coordinator.id);
        children.get(coordinator.id).push(n);
      }
    }

    const maxDepth = Math.max(1, ...Array.from(depth.values()));
    const ringGap = (Math.min(width, height) * 0.42) / maxDepth;

    // Subtree leaf-count, used to proportionally divide angular space.
    const leafCount = new Map();
    const countLeaves = (node) => {
      const kids = children.get(node.id);
      if (!kids.length) {
        leafCount.set(node.id, 1);
        return 1;
      }
      let sum = 0;
      for (const c of kids) sum += countLeaves(c);
      leafCount.set(node.id, sum);
      return sum;
    };
    countLeaves(coordinator);

    coordinator.x = cx;
    coordinator.y = cy;
    coordinator.angle = 0;

    const place = (node, angleStart, angleEnd) => {
      const kids = children.get(node.id);
      if (!kids.length) return;
      let cursor = angleStart;
      const span = angleEnd - angleStart;
      const total = leafCount.get(node.id) || 1;
      for (const child of kids) {
        const portion = (leafCount.get(child.id) || 1) / total;
        const childStart = cursor;
        const childEnd = cursor + span * portion;
        const angle = (childStart + childEnd) / 2;
        const r = depth.get(child.id) * ringGap;
        child.x = cx + r * Math.cos(angle);
        child.y = cy + r * Math.sin(angle);
        child.angle = angle;
        place(child, childStart, childEnd);
        cursor = childEnd;
      }
    };
    place(coordinator, 0, Math.PI * 2);

    // Light relaxation pass: small, capped node movements that resolve
    // local crowding without unraveling the radial ordering established
    // above (unlike a full force-directed simulation).
    const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.9;
    for (let iter = 0; iter < 60; iter++) {
      for (const n of nodes) { n.fx = 0; n.fy = 0; }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          if (dist > k * 1.5) continue; // only nearby nodes interact
          const force = (k * k) / (dist * dist);
          dx /= dist; dy /= dist;
          a.fx += dx * force; a.fy += dy * force;
          b.fx -= dx * force; b.fy -= dy * force;
        }
      }
      const cap = 2.5;
      for (const n of nodes) {
        if (n === coordinator) continue;
        const disp = Math.hypot(n.fx, n.fy) || 0.01;
        const move = Math.min(disp, cap);
        n.x += (n.fx / disp) * move;
        n.y += (n.fy / disp) * move;
        n.x = Math.min(width - n.r - 4, Math.max(n.r + 4, n.x));
        n.y = Math.min(height - n.r - 4, Math.max(n.r + 4, n.y));
      }
    }

    this._resolveOverlaps(nodes, width, height);
  }

  // The force simulation minimizes overlap but, with many hub-connected
  // nodes (everything talking to one router), some residual overlap is
  // common. This pass does a few direct separation passes afterwards so
  // labels stay legible even in dense clusters.
  _resolveOverlaps(nodes, width, height) {
    const minGap = 6;
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const minDist = a.r + b.r + minGap;
          let dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) { dx = 0.5; dy = 0.5; dist = 0.01; }
          if (dist < minDist) {
            const push = (minDist - dist) / 2;
            dx /= dist; dy /= dist;
            if (a.kind !== "coordinator") {
              a.x -= dx * push; a.y -= dy * push;
            }
            if (b.kind !== "coordinator") {
              b.x += dx * push; b.y += dy * push;
            }
            moved = true;
          }
        }
      }
      for (const n of nodes) {
        n.x = Math.min(width - n.r - 4, Math.max(n.r + 4, n.x));
        n.y = Math.min(height - n.r - 4, Math.max(n.r + 4, n.y));
      }
      if (!moved) break;
    }
  }

  _draw() {
    const ctx = this._ctx;
    if (!ctx) return;
    const w = this._cssWidth || 600;
    const h = this._cssHeight || 400;
    ctx.clearRect(0, 0, w, h);

    if (!this._nodes.length) {
      ctx.fillStyle = "#888";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        this._hass ? "Keine ZHA-Geräte gefunden" : "Lade …",
        w / 2,
        h / 2
      );
      return;
    }

    ctx.save();
    ctx.translate(w / 2 + this._offset.x, h / 2 + this._offset.y);
    ctx.scale(this._scale, this._scale);
    ctx.translate(-w / 2, -h / 2);

    // edges
    for (const e of this._edges) {
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.strokeStyle = lqiColor(e.lqi);
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;

      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2;
      if (this._scale > 0.6) {
        ctx.fillStyle = "rgba(127,127,127,0.9)";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(String(e.lqi), mx, my);
      }
    }

    // nodes
    for (const n of this._nodes) {
      const isSelected = this._selected === n;
      const fill =
        n.kind === "coordinator"
          ? "#1f8de8"
          : n.kind === "router"
          ? "#3ba776"
          : "#9c8ad9";
      ctx.beginPath();
      if (n.kind === "coordinator") {
        const s = n.r;
        ctx.fillStyle = fill;
        ctx.fillRect(n.x - s, n.y - s, s * 2, s * 2);
        if (isSelected) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.strokeRect(n.x - s, n.y - s, s * 2, s * 2);
        }
      } else if (n.kind === "router") {
        ctx.ellipse(n.x, n.y, n.r, n.r * 0.78, 0, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (isSelected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      } else {
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (isSelected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      }

      if (n.device.available === false) {
        ctx.beginPath();
        ctx.arc(n.x + n.r * 0.7, n.y - n.r * 0.7, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#d8453a";
        ctx.fill();
      }

      if (this._scale > 0.5) {
        ctx.fillStyle = "rgba(230,230,230,0.95)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        const label = n.displayName || n.device.name || n.device.ieee || "";
        ctx.fillText(label.length > 18 ? label.slice(0, 17) + "…" : label, n.x, n.y + n.r + 11);
      }
    }

    ctx.restore();
  }

  static getStubConfig() {
    return { title: "ZHA Netzwerk", refresh_interval: 60 };
  }
}

if (!customElements.get("zha-network-card")) {
  customElements.define("zha-network-card", ZhaNetworkCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "zha-network-card",
  name: "ZHA Network Card",
  description:
    "Grafische ZHA-Mesh-Visualisierung (Koordinator, Router, Endgeräte, LQI-Verbindungen) direkt im Dashboard.",
  preview: false,
});

console.info(
  `%c ZHA-NETWORK-CARD %c v${CARD_VERSION} `,
  "color: white; background: #1f8de8; font-weight: 700;",
  "color: #1f8de8; background: transparent; font-weight: 700;"
);
