/* ============================================================================
 * simpletagdisplay.js — CTG (Click-To-Graph) frontend for Ignition Perspective
 * ============================================================================
 *
 * Single bundled file (no build step). Loaded by the gateway hook as a mounted
 * resource at  /res/simpletagdisplay/js/simpletagdisplay.js  and registered with
 * Perspective via window.PerspectiveClient.ComponentRegistry.
 *
 * It defines TWO Perspective components:
 *
 *   1. SimpleTagDisplay  — shows one tag's value as a label.
 *      • Reads its value via the shared, batched TagReadPoller (SECTION 0):
 *        every display on the page is coalesced into ONE /readTags request per
 *        tick (default 1 s) instead of one /readTag per component every 250 ms.
 *      • Right-click on the value → context menu with "Trend Tag" / "Remove Tag"
 *        (only when tag is historized — checked via /isHistorized).
 *      • Optional setpoint write modal (/writeTag) when the `setpoint` prop is on.
 *      • Bounds-based color highlighting and dynamic font sizing (ResizeObserver).
 *      • On add/remove: dispatches `window` CustomEvent 'ctg-trend-list-changed'
 *        so every CtgChart on the page reloads immediately.
 *
 *   2. CtgChart  — session-scoped trend chart rendered with uPlot.
 *      • Reads tag list from /trendList (per-session in TrendListStore on the gateway).
 *      • Pulls historian buckets via /tagHistory and live values via /readTags in parallel.
 *      • Drives a sliding "now" window via explicit setScale; supports custom
 *        historical date ranges and free-range pan/zoom that re-queries the historian.
 *      • Three interaction modes: X-Trace (hover tooltip), Pan (drag + wheel-zoom),
 *        Zoom (drag-select).
 *
 * Backend routes consumed (all under /data/simpletagdisplay or /main/data/simpletagdisplay):
 *   - /readTag, /writeTag, /isHistorized        (TagReadRoutes.java)
 *   - /trendList, /addToTrendList,              (TrendRoutes.java)
 *     /removeFromTrendList, /tagHistory
 *
 * uPlot quirks worth knowing (these caused multiple bugs during development):
 *   - `cursor.drag` is a partial overlay on the default object; you MUST include
 *     `dist: 0` or drag-to-zoom never arms.
 *   - Setting `scales.x.auto: false` skips the auto-fit pass, so a `range()`
 *     function never gets called → we drive the x window with explicit setScale.
 *   - `setData(data, false)` updates buffers without committing on its own; pair
 *     it with setScale inside `uplot.batch(...)` to get a single commit/redraw.
 *   - Anything that calls setScale internally (setData with auto, setSize, init)
 *     fires the `setScale` hook. We use `_suppressScaleHook` to flag programmatic
 *     calls so they're not mistaken for user-initiated zoom/pan gestures.
 *
 * File layout (search anchors in this file):
 *   - "SimpleTagDisplayMeta"       — Perspective metadata for SimpleTagDisplay
 *   - "class SimpleTagDisplay"     — implementation
 *   - "CTG Chart"                  — section header for the chart
 *   - "loadUPlot"                  — lazy loader for uPlot JS+CSS
 *   - "CtgChartMeta"               — Perspective metadata for CtgChart
 *   - "class CtgChart"             — implementation
 * ============================================================================ */

const { Component, ComponentRegistry } = window.PerspectiveClient;


/* ============================================================================
 * SECTION 0 / TagReadPoller — shared, batched tag-value poller
 * ----------------------------------------------------------------------------
 * ONE poller for the whole page. Every SimpleTagDisplay (and any other caller)
 * subscribes the tag paths it cares about; the poller coalesces ALL of them
 * into a single request per tick against the gateway's batch /readTags route.
 *
 * Why this exists:
 *   The old design gave every SimpleTagDisplay its own setInterval firing an
 *   independent /readTag every 250 ms. With 30+ components on a view that is
 *   120+ HTTP requests/second — well past the browser's ~6-connection-per-origin
 *   limit, so requests queue, time out, and the components fail to load / "crash".
 *   It also hammers the gateway's HTTP worker threads (each /readTag blocks a
 *   thread on a synchronous tag read).
 *
 * What this does instead:
 *   - Dedupes tag paths across all subscribers (same tag shown 5×  → read once).
 *   - Issues ONE request per tick carrying every distinct path (chunked so URLs
 *     stay sane and each bulk read is bounded).
 *   - Guards against overlap: if a poll is still in flight when the next tick
 *     fires, that tick is skipped (a slow gateway can never cause a pile-up).
 *   - Delivers each path's last value to a subscriber immediately on subscribe,
 *     and does a debounced "poll soon" so a freshly-mounted component doesn't
 *     wait a whole interval for its first value.
 *
 * Cadence:
 *   Default 1000 ms (standard HMI value-refresh rate; 4× less load than the old
 *   250 ms). Override globally at runtime with  window.__CTG_TAG_POLL_MS = <ms>.
 *
 * Result shape delivered to each subscriber callback:
 *   { value?, quality?, isGood: bool }   (from /readTags; value is a string)
 *   On a transport/HTTP failure the last value is retained (no flap to error);
 *   a parsed response that omits a path yields { isGood:false } for that path.
 * ============================================================================ */
const TagReadPoller = (function () {
    const DEFAULT_INTERVAL_MS = 1000;   // steady-state refresh cadence
    const MAX_PATHS_PER_REQUEST = 40;   // chunk size so one bulk read stays bounded
    const REQUEST_TIMEOUT_MS = 20000;   // abort a stuck request so it can't wedge inFlight
    const POLL_SOON_DEBOUNCE_MS = 30;   // coalesce a burst of mounts into one poll

    const byPath = new Map();   // tagPath -> Set<callback>
    const latest = new Map();   // tagPath -> last delivered result (for instant delivery on subscribe)
    let loopTimer = null;       // setTimeout handle for the steady poll loop
    let soonHandle = null;      // setTimeout handle for a debounced immediate poll
    let inFlight = false;       // a poll request is currently outstanding
    let pending = false;        // a poll was requested while one was in flight — honor it on completion
    let resolvedBase = null;    // '/data/...' vs '/main/data/...' once we know which answers

    function intervalMs() {
        const o = (typeof window !== 'undefined' && Number(window.__CTG_TAG_POLL_MS)) || 0;
        return o > 0 ? o : DEFAULT_INTERVAL_MS;
    }

    // Candidate base URLs, best-guess first (Designer session views live under /main/).
    function candidateBases() {
        const main = typeof window !== 'undefined' && window.location.pathname.indexOf('/main/') !== -1;
        return main
            ? ['/main/data/simpletagdisplay', '/data/simpletagdisplay']
            : ['/data/simpletagdisplay', '/main/data/simpletagdisplay'];
    }

    // Steady loop is a SELF-RESCHEDULING setTimeout (not setInterval) so that:
    //   - the cadence re-reads intervalMs() every tick → a live window.__CTG_TAG_POLL_MS
    //     change actually takes effect;
    //   - the next tick is only armed AFTER the current poll resolves → requests never
    //     overlap and a slow gateway naturally throttles the cadence (no pile-up).
    function ensureLoop() {
        if (loopTimer == null && byPath.size > 0) loopTimer = setTimeout(loopTick, intervalMs());
    }
    function stopLoop() {
        if (loopTimer != null) { clearTimeout(loopTimer); loopTimer = null; }
    }
    function loopTick() {
        loopTimer = null;
        poll().then(function () {
            // Reschedule only if still needed and not already re-armed by a fresh subscribe.
            if (byPath.size > 0 && loopTimer == null) loopTimer = setTimeout(loopTick, intervalMs());
        });
    }

    function subscribe(tagPath, cb) {
        if (!tagPath || typeof cb !== 'function') return function () {};
        let set = byPath.get(tagPath);
        if (!set) { set = new Set(); byPath.set(tagPath, set); }
        set.add(cb);
        if (latest.has(tagPath)) { try { cb(latest.get(tagPath)); } catch (_) {} }
        ensureLoop();
        pollSoon();
        return function unsubscribe() {
            const s = byPath.get(tagPath);
            if (s) {
                s.delete(cb);
                if (s.size === 0) { byPath.delete(tagPath); latest.delete(tagPath); }
            }
            if (byPath.size === 0) stopLoop();
        };
    }

    // Debounced near-immediate poll (used on subscribe + after a write).
    function pollSoon() {
        if (soonHandle != null) return;
        soonHandle = setTimeout(function () { soonHandle = null; poll(); }, POLL_SOON_DEBOUNCE_MS);
    }

    function fetchChunk(base, chunk) {
        const q = chunk.map(encodeURIComponent).join(',');
        let ctrl = null, to = null;
        try { ctrl = new AbortController(); } catch (_) { ctrl = null; }
        const opts = { method: 'GET', credentials: 'same-origin' };
        if (ctrl) {
            opts.signal = ctrl.signal;
            to = setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS);
        }
        return fetch(base + '/readTags?tagPaths=' + q, opts)
            .then(function (r) {
                if (r.status === 404) { const e = new Error('404'); e.notFound = true; throw e; }
                return r.ok ? r.json() : null;
            })
            .then(function (data) { return { chunk: chunk, data: data, notFound: false }; })
            .catch(function (err) { return { chunk: chunk, data: null, notFound: !!(err && err.notFound) }; })
            .then(function (res) { if (to != null) clearTimeout(to); return res; });
    }

    // Always resolves (never rejects) once the poll completes, so the loop can reschedule off it.
    function poll() {
        if (inFlight) { pending = true; return Promise.resolve(); }
        const paths = Array.from(byPath.keys());
        if (!paths.length) return Promise.resolve();
        inFlight = true;

        let chain;
        try {
            const chunks = [];
            for (let i = 0; i < paths.length; i += MAX_PATHS_PER_REQUEST) {
                chunks.push(paths.slice(i, i + MAX_PATHS_PER_REQUEST));
            }
            const bases = candidateBases();
            const base = resolvedBase || bases[0];

            chain = Promise.all(chunks.map(function (c) { return fetchChunk(base, c); }))
                .then(function (results) {
                    // First time only: if every chunk 404'd, our base guess was wrong — retry the alternate.
                    const all404 = !resolvedBase && results.length > 0 && results.every(function (r) { return r.notFound; });
                    if (all404 && bases[1] && bases[1] !== base) {
                        return Promise.all(chunks.map(function (c) { return fetchChunk(bases[1], c); }))
                            .then(function (r2) {
                                if (r2.some(function (r) { return r.data; })) resolvedBase = bases[1];
                                return r2;
                            });
                    }
                    if (!resolvedBase && results.some(function (r) { return r.data; })) resolvedBase = base;
                    return results;
                })
                .then(dispatch)
                .catch(function () { /* swallow — never let a poll error kill the loop */ });
        } catch (e) {
            chain = Promise.resolve();   // synchronous failure building the chain — still reset inFlight below
        }

        return chain.then(function () {
            inFlight = false;
            // A subscribe/write that arrived mid-flight requested a poll we skipped — honor it now.
            if (pending) { pending = false; pollSoon(); }
        });
    }

    function dispatch(results) {
        results.forEach(function (r) {
            if (!r) return;
            if (!r.data) {
                // Transport/HTTP failure (network down, timeout/abort, gateway restarting).
                // Retain the last value for paths that already have one (no flap to error);
                // for paths that have NEVER received a value, surface a disconnected state so
                // an initial 'Loading…' resolves instead of hanging forever. Do NOT cache the
                // marker, so the next successful read is still treated as a first delivery.
                r.chunk.forEach(function (path) {
                    if (latest.has(path)) return;
                    const set = byPath.get(path);
                    if (set) set.forEach(function (cb) { try { cb({ isGood: false, error: 'Disconnected' }); } catch (_) {} });
                });
                return;
            }
            const values = r.data.values || {};
            r.chunk.forEach(function (path) {
                const res = Object.prototype.hasOwnProperty.call(values, path)
                    ? values[path]
                    : { isGood: false };
                // Only cache paths that are still subscribed — a path may have unsubscribed
                // while this request was in flight; re-inserting it would leak `latest` forever.
                if (byPath.has(path)) latest.set(path, res);
                const set = byPath.get(path);
                if (set) set.forEach(function (cb) { try { cb(res); } catch (_) {} });
            });
        });
    }

    return { subscribe: subscribe, pollSoon: pollSoon };
})();


/* ============================================================================
 * SECTION 1 / SimpleTagDisplay
 * ----------------------------------------------------------------------------
 * One-tag value display with optional setpoint-write modal and a right-click
 * context menu that calls /addToTrendList or /removeFromTrendList on the gateway.
 * ============================================================================ */

/**
 * Component metadata read by Perspective at registration time.
 * - getComponentType(): unique ID matched against simpletagdisplay.props.json
 * - getViewComponent(): the React class that actually renders.
 * - getDefaultSize():   the W×H Perspective uses when the component is dropped
 *                       onto a view from the palette.
 * - getPropsReducer(tree): converts the prop tree (Perspective binds & writes)
 *                          into a flat JS object passed as `this.props.props`.
 */
class SimpleTagDisplayMeta {
    getComponentType() {
        return "com.example.simpletagdisplay.SimpleTagDisplay";
    }

    getViewComponent() {
        return SimpleTagDisplay;
    }

    getDefaultSize() {
        return {
            width: 250,
            height: 70
        };
    }

    getPropsReducer(tree) {
        // Each tree.read*(key, default) maps to a property defined in
        // common/src/main/resources/simpletagdisplay.props.json.
        return {
            tagPath: tree.readString("tagPath", ""),                         // full tag path e.g. "[default]Folder/MyTag"
            showTagName: tree.readBoolean("showTagName", true),
            showTagValue: tree.readBoolean("showTagValue", true),
            tagNameLabel: tree.readString("tagNameLabel", ""),               // override for the displayed tag name
            valuePrecision: tree.readNumber("valuePrecision", 1),            // decimal places for numeric values
            row: tree.readBoolean("row", false),                             // false = stacked, true = name + value side-by-side
            evenRow: tree.readBoolean("evenRow", false),                     // 50/50 column widths in row mode
            verticalAlign: tree.readString("verticalAlign", "top"),
            showUnits: tree.readBoolean("showUnits", false),                 // append .EngUnit (polled separately every 5 s)
            boolean: tree.read("boolean", {                                   // optional textOnTrue / textOnFalse overrides
                textOnTrue: "",
                textOnFalse: ""
            }),
            bounds: tree.read("bounds", {                                     // limit highlighting driven by the tag's EngLow/EngHigh
                enabled: false,
                minColor: "#FF0000",
                maxColor: "#00FF00",
                minInclusive: false,
                maxInclusive: false
            }),
            setpoint: tree.readBoolean("setpoint", false),                   // when true, clicking the value opens a write modal
            tagNameStyle: tree.read("tagNameStyle", { classes: "" }),
            tagValueStyle: tree.read("tagValueStyle", { classes: "" })
        };
    }
}

/**
 * SimpleTagDisplay — React component (Perspective extends a custom Component class).
 *
 * Lifecycle summary:
 *   componentDidMount       → subscribeTag() (shared poller) + setupSizeTracking() (ResizeObserver for auto-font-sizing)
 *   componentDidUpdate      → re-subscribe if tagPath or showUnits changed
 *   componentWillUnmount    → unsubscribeTag() + tear down ResizeObserver and any document click handler
 *
 * State at a glance:
 *   tagValue / isConnected      — last reading delivered by the shared TagReadPoller (or sentinel strings)
 *   engUnit                     — last reading of "<tagPath>.EngUnit" (only when showUnits is on)
 *   componentWidth / Height     — observed by ResizeObserver, used for auto-font-sizing
 *   showSetpointModal + ...     — modal state for tag writes (only with setpoint=true)
 *   contextMenu*                — right-click menu (Trend/Remove); historized + isTrending flags
 *                                 control what entries appear, queried lazily on right-click.
 */
class SimpleTagDisplay extends Component {
    constructor(props) {
        super(props);
        this.state = {
            tagValue: 'Loading...',
            isConnected: false,
            componentWidth: 0,
            componentHeight: 0,
            showSetpointModal: false,
            setpointInputValue: '',
            setpointSubmitError: null,
            contextMenuVisible: false,
            contextMenuX: 0,
            contextMenuY: 0,
            contextMenuHistorized: false,    // is this tag historized? Trend/Remove only show if true.
            contextMenuIsTrending: false      // is this tag already in the session trend list?
        };
        this._unsubValue = null;              // TagReadPoller unsubscribe fn for the value path
        this._unsubUnit = null;               // TagReadPoller unsubscribe fn for the ".EngUnit" path
        this._unsubLow = null;                // TagReadPoller unsubscribe fn for the ".EngLow" path (bounds)
        this._unsubHigh = null;               // TagReadPoller unsubscribe fn for the ".EngHigh" path (bounds)
        this.componentRef = null;             // root DOM node (used by ResizeObserver)
    }

    openSetpointModal = () => {
        const { tagPath, setpoint } = this.props.props;
        if (!setpoint || !tagPath || !tagPath.trim()) return;
        const currentVal = this.state.tagValue;
        const initialValue = (currentVal !== null && currentVal !== undefined && currentVal !== 'Loading...' && currentVal !== 'No Tag Path' && currentVal !== 'Disconnected' && !isNaN(parseFloat(currentVal)))
            ? String(currentVal)
            : '';
        this.setState({ showSetpointModal: true, setpointInputValue: initialValue, setpointSubmitError: null });
    };

    closeSetpointModal = () => {
        this.setState({ showSetpointModal: false, setpointInputValue: '', setpointSubmitError: null });
    };

    onSetpointInputChange = (e) => {
        this.setState({ setpointInputValue: e.target.value, setpointSubmitError: null });
    };

    submitSetpoint = () => {
        const { tagPath } = this.props.props;
        const { setpointInputValue } = this.state;
        const trimmed = setpointInputValue.trim();
        if (!tagPath || !tagPath.trim()) {
            this.setState({ setpointSubmitError: 'No tag path configured.' });
            return;
        }
        if (trimmed === '') {
            this.setState({ setpointSubmitError: 'Please enter a value.' });
            return;
        }
        const num = parseFloat(trimmed);
        if (isNaN(num) || !isFinite(num)) {
            this.setState({ setpointSubmitError: 'Value must be a number.' });
            return;
        }
        const urlsToTry = [
            `/data/simpletagdisplay/writeTag?tagPath=${encodeURIComponent(tagPath)}&value=${encodeURIComponent(trimmed)}`,
            `/main/data/simpletagdisplay/writeTag?tagPath=${encodeURIComponent(tagPath)}&value=${encodeURIComponent(trimmed)}`
        ];
        const setError = (msg) => this.setState({ setpointSubmitError: msg });
        const tryFetch = (urlIndex) => {
            if (urlIndex >= urlsToTry.length) {
                setError('Write failed. Endpoint not found (tried both URLs). Check gateway and module.');
                return;
            }
            const url = urlsToTry[urlIndex];
            fetch(url)
                .then(response => {
                    return response.text().then(text => {
                        let data = null;
                        try {
                            if (text && text.trim()) data = JSON.parse(text);
                        } catch (_) { /* ignore */ }
                        if (!response.ok) {
                            if (response.status === 404 && urlIndex < urlsToTry.length - 1) return tryFetch(urlIndex + 1);
                            const msg = (data && data.error) || ('HTTP ' + response.status + (response.status === 404 ? ' – write endpoint not found' : ''));
                            setError(msg || ('Write failed (HTTP ' + response.status + '). Check gateway logs.'));
                            return null;
                        }
                        return data;
                    });
                })
                .then(data => {
                    if (data === null) {
                        setError('Write failed. No valid response (check browser console F12 for details).');
                        return;
                    }
                    if (data && data.success) {
                        this.closeSetpointModal();
                        TagReadPoller.pollSoon();   // refresh the displayed value promptly after a write
                    } else {
                        const msg = (data && (data.error || data.message)) || 'Write failed (no details from server).';
                        setError(msg);
                    }
                })
                .catch(err => {
                    if (urlIndex < urlsToTry.length - 1) return tryFetch(urlIndex + 1);
                    setError('Error: ' + (err.message || 'Request failed'));
                });
        };
        tryFetch(0);
    };

    /* ---- Right-click context menu (Trend Tag / Remove Tag) ----------------
     * Only opens for historized tags. Two API checks fire in parallel:
     *   /isHistorized   — should the menu show at all?
     *   /trendList      — is this tag already trending? (decides Trend vs Remove)
     * Click handlers (onTrendTagClick / onRemoveTagClick) call the gateway
     * and then dispatch a window-level CustomEvent 'ctg-trend-list-changed'
     * so every CtgChart on the page reloads immediately, no polling delay.
     * --------------------------------------------------------------------- */

    closeContextMenu = () => {
        this.setState({ contextMenuVisible: false });
    };

    onValueContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { tagPath } = this.props.props;
        if (!tagPath || !tagPath.trim()) return;
        const trimmedPath = tagPath.trim();

        const fetchWithFallback = (paths) => {
            const [first, ...rest] = paths;
            return fetch(first)
                .then(res => res.ok ? res.json() : Promise.reject())
                .catch(() => rest.length ? fetchWithFallback(rest) : Promise.resolve(null));
        };

        const historizedUrls = [
            `/data/simpletagdisplay/isHistorized?tagPath=${encodeURIComponent(trimmedPath)}`,
            `/main/data/simpletagdisplay/isHistorized?tagPath=${encodeURIComponent(trimmedPath)}`
        ];
        const trendListUrls = [
            `/data/simpletagdisplay/trendList`,
            `/main/data/simpletagdisplay/trendList`
        ];

        Promise.all([
            fetchWithFallback(historizedUrls),
            fetchWithFallback(trendListUrls)
        ]).then(([histData, trendData]) => {
            const historized = !!(histData && histData.historized);
            const trendPaths = (trendData && trendData.tagPaths) || [];
            const isTrending = trendPaths.includes(trimmedPath);
            this.setState({
                contextMenuVisible: true,
                contextMenuX: e.clientX,
                contextMenuY: e.clientY,
                contextMenuHistorized: historized,
                contextMenuIsTrending: isTrending
            });
        }).catch(() => {
            this.setState({
                contextMenuVisible: true,
                contextMenuX: e.clientX,
                contextMenuY: e.clientY,
                contextMenuHistorized: false,
                contextMenuIsTrending: false
            });
        });
    };

    _fetchFirstWorking(urls) {
        const [first, ...rest] = urls;
        return fetch(first, { method: 'GET', credentials: 'same-origin' })
            .then(res => res.ok ? res.json() : Promise.reject())
            .catch(() => rest.length ? this._fetchFirstWorking(rest) : Promise.resolve(null));
    }

    onTrendTagClick = () => {
        const { tagPath } = this.props.props;
        if (!tagPath || !tagPath.trim()) { this.closeContextMenu(); return; }
        const trimmedPath = tagPath.trim();
        this._fetchFirstWorking([
            '/data/simpletagdisplay/addToTrendList?tagPath=' + encodeURIComponent(trimmedPath),
            '/main/data/simpletagdisplay/addToTrendList?tagPath=' + encodeURIComponent(trimmedPath)
        ]).then(() => {
            this.closeContextMenu();
            window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'));
        });
    };

    onRemoveTagClick = () => {
        const { tagPath } = this.props.props;
        if (!tagPath || !tagPath.trim()) { this.closeContextMenu(); return; }
        const trimmedPath = tagPath.trim();
        this._fetchFirstWorking([
            '/data/simpletagdisplay/removeFromTrendList?tagPath=' + encodeURIComponent(trimmedPath),
            '/main/data/simpletagdisplay/removeFromTrendList?tagPath=' + encodeURIComponent(trimmedPath)
        ]).then(() => {
            this.closeContextMenu();
            window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'));
        });
    };

    componentDidMount() {
        this._isMounted = true;
        this.boundCloseContextMenu = () => this.closeContextMenu();
        // Subscribe this tag (and, if enabled, its .EngUnit) to the shared batched poller.
        this.subscribeTag();
        // Set up resize observer for auto font sizing. The setTimeout defers until the element
        // exists; track its id so a fast unmount can cancel it (otherwise the callback would
        // create an un-torn-down ResizeObserver after componentWillUnmount already ran).
        this._sizeInitTimer = setTimeout(() => {
            this._sizeInitTimer = null;
            this.setupSizeTracking();
        }, 0);
    }
    
    setupSizeTracking() {
        if (this._isMounted === false) return;   // fast unmount raced the setTimeout(0) — don't observe
        if (this.props.store && this.props.store.element) {
            this.componentRef = this.props.store.element;
            this.updateComponentSize();
            // Use ResizeObserver if available, otherwise fall back to polling
            if (window.ResizeObserver) {
                this.resizeObserver = new ResizeObserver(() => {
                    this.updateComponentSize();
                });
                this.resizeObserver.observe(this.componentRef);
            } else {
                // Fallback: check size periodically
                this.sizeCheckInterval = setInterval(() => {
                    this.updateComponentSize();
                }, 100);
            }
        }
    }
    
    updateComponentSize() {
        const element = this.componentRef || (this.props.store && this.props.store.element);
        if (element) {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && 
                (rect.width !== this.state.componentWidth || rect.height !== this.state.componentHeight)) {
                this.setState({
                    componentWidth: rect.width,
                    componentHeight: rect.height
                });
            }
        }
    }

    componentWillUnmount() {
        this._isMounted = false;
        // Cancel any pending setTimeout(0) callbacks so they can't run (and register
        // observers/listeners) after this teardown.
        if (this._sizeInitTimer) { clearTimeout(this._sizeInitTimer); this._sizeInitTimer = null; }
        if (this._ctxMenuTimer) { clearTimeout(this._ctxMenuTimer); this._ctxMenuTimer = null; }
        document.removeEventListener('click', this.boundCloseContextMenu);
        // Unsubscribe from the shared poller when the component is removed
        this.unsubscribeTag();
        // Clean up resize observer
        if (this.resizeObserver && this.componentRef) {
            this.resizeObserver.unobserve(this.componentRef);
            this.resizeObserver = null;
        }
        if (this.sizeCheckInterval) {
            clearInterval(this.sizeCheckInterval);
            this.sizeCheckInterval = null;
        }
    }

    componentDidUpdate(prevProps, prevState) {
        if (this.state.contextMenuVisible && !prevState.contextMenuVisible) {
            // Track the timer id so a fast unmount cancels it — otherwise this could add a
            // document click listener bound to a dead component after componentWillUnmount ran.
            this._ctxMenuTimer = setTimeout(() => {
                this._ctxMenuTimer = null;
                document.addEventListener('click', this.boundCloseContextMenu);
            }, 0);
        }
        if (!this.state.contextMenuVisible && prevState.contextMenuVisible) {
            document.removeEventListener('click', this.boundCloseContextMenu);
        }
        // Re-subscribe to the shared poller when the tag path, unit visibility, or
        // bounds-enabled state changes (bounds adds the .EngLow/.EngHigh subscriptions).
        const prevBoundsEnabled = !!((prevProps.props.bounds || {}).enabled);
        const curBoundsEnabled  = !!((this.props.props.bounds || {}).enabled);
        if (prevProps.props.tagPath !== this.props.props.tagPath ||
            prevProps.props.showUnits !== this.props.props.showUnits ||
            prevBoundsEnabled !== curBoundsEnabled) {
            this.subscribeTag();
        }
        // Update component size if font properties changed
        if (prevProps.props.tagNameFont !== this.props.props.tagNameFont ||
            prevProps.props.tagValueFont !== this.props.props.tagValueFont) {
            this.updateComponentSize();
        }
    }

    /* ---- Shared-poller subscription -----------------------------------------
     * The tag value and (optionally) its ".EngUnit" are read by the module-wide
     * TagReadPoller — ONE batched /readTags request for the whole page — instead
     * of a per-instance setInterval hitting /readTag. subscribeTag() (re)registers
     * our callbacks; unsubscribeTag() releases them. The callbacks only call
     * setState when the value actually changed, so a static tag never triggers a
     * re-render on a poll tick (important with dozens of these on one view).
     * ----------------------------------------------------------------------- */

    subscribeTag() {
        this.unsubscribeTag();
        const { tagPath, showUnits, bounds } = this.props.props;
        if (!tagPath || !tagPath.trim()) {
            this.setState({ tagValue: 'No Tag Path', isConnected: false, engUnit: '' });
            return;
        }
        const path = tagPath.trim();
        this._unsubValue = TagReadPoller.subscribe(path, this.handleTagValue);
        if (showUnits) {
            this._unsubUnit = TagReadPoller.subscribe(path + '.EngUnit', this.handleEngUnit);
        } else if (this.state.engUnit) {
            this.setState({ engUnit: '' });
        }
        // Bounds highlighting reads the tag's Engineering Low/High Limit (EngLow/EngHigh),
        // same batched-poller mechanism as EngUnit — no user-entered min/max any more.
        if (bounds && bounds.enabled) {
            this._unsubLow  = TagReadPoller.subscribe(path + '.EngLow',  this.handleEngLow);
            this._unsubHigh = TagReadPoller.subscribe(path + '.EngHigh', this.handleEngHigh);
        }
    }

    unsubscribeTag() {
        if (this._unsubValue) { this._unsubValue(); this._unsubValue = null; }
        if (this._unsubUnit)  { this._unsubUnit();  this._unsubUnit = null; }
        if (this._unsubLow)   { this._unsubLow();   this._unsubLow = null; }
        if (this._unsubHigh)  { this._unsubHigh();  this._unsubHigh = null; }
    }

    // Poller callback for the tag's value. res = { value?, quality?, isGood } from /readTags.
    handleTagValue = (res) => {
        if (res && res.isGood) {
            const v = res.value;
            if (this.state.tagValue !== v || !this.state.isConnected) {
                this.setState({ tagValue: v, isConnected: true });
            }
        } else {
            const msg = (res && res.error) || 'Bad Quality';
            if (this.state.isConnected || this.state.tagValue !== msg) {
                this.setState({ tagValue: msg, isConnected: false });
            }
        }
    };

    // Poller callback for "<tagPath>.EngUnit". Missing/bad-quality → empty string.
    handleEngUnit = (res) => {
        let unit = '';
        if (res && res.isGood && res.value != null) unit = String(res.value).trim();
        if (this.state.engUnit !== unit) this.setState({ engUnit: unit });
    };

    // Poller callbacks for the tag's Engineering Low/High Limit (bounds highlighting).
    // A non-finite / bad-quality read → null (that bound simply isn't applied).
    handleEngLow = (res) => {
        let v = null;
        if (res && res.isGood && res.value != null) { const n = parseFloat(res.value); if (Number.isFinite(n)) v = n; }
        if (this.state.engLow !== v) this.setState({ engLow: v });
    };
    handleEngHigh = (res) => {
        let v = null;
        if (res && res.isGood && res.value != null) { const n = parseFloat(res.value); if (Number.isFinite(n)) v = n; }
        if (this.state.engHigh !== v) this.setState({ engHigh: v });
    };

    render() {
        // Extract props - note that props are nested in this.props.props
        const { props } = this.props;
        const { tagPath, showTagName, showTagValue, tagNameLabel, valuePrecision, row, evenRow, verticalAlign, showUnits, setpoint, boolean: booleanConfig, bounds, tagNameStyle, tagValueStyle } = props;
        const { emit } = this.props;
        
        // Use state for tag value (from polling) and EngUnit
        const { tagValue, isConnected, engUnit, showSetpointModal, setpointInputValue, setpointSubmitError, contextMenuVisible, contextMenuX, contextMenuY, contextMenuHistorized } = this.state;
        
        // Extract tag name from path
        let tagName = 'No Tag Selected';
        if (tagNameLabel && tagNameLabel.trim()) {
            tagName = tagNameLabel;
        } else if (tagPath && tagPath.trim()) {
            let path = tagPath;
            if (path.includes(']')) {
                path = path.split(']')[1]; // Remove provider prefix
            }
            const parts = path.split('/');
            tagName = parts[parts.length - 1] || 'No Tag Selected';
        }
        
        // Format the tag value based on data type
        let formattedValue = tagValue;
        
        if (isConnected && tagValue !== null && tagValue !== undefined) {
            // Check if value is a boolean (true/false as string or actual boolean)
            const isBooleanValue = tagValue === true || tagValue === false || 
                                   tagValue === 'true' || tagValue === 'false' ||
                                   tagValue === 'True' || tagValue === 'False' ||
                                   tagValue === 'TRUE' || tagValue === 'FALSE';
            
            if (isBooleanValue) {
                // Convert to actual boolean for comparison
                const boolValue = tagValue === true || tagValue === 'true' || tagValue === 'True' || tagValue === 'TRUE';
                
                if (boolValue) {
                    // Value is true - use textOnTrue if provided, otherwise "true"
                    formattedValue = (booleanConfig && booleanConfig.textOnTrue && booleanConfig.textOnTrue.trim()) 
                        ? booleanConfig.textOnTrue.trim() 
                        : 'true';
                } else {
                    // Value is false - use textOnFalse if provided, otherwise "false"
                    formattedValue = (booleanConfig && booleanConfig.textOnFalse && booleanConfig.textOnFalse.trim()) 
                        ? booleanConfig.textOnFalse.trim() 
                        : 'false';
                }
            } else if (!isNaN(tagValue) && isFinite(tagValue)) {
                // Numeric value - apply precision
                const numValue = parseFloat(tagValue);
                formattedValue = numValue.toFixed(valuePrecision);
                
                // Append EngUnit if showUnits is true and unit exists
                if (showUnits && engUnit && engUnit.trim()) {
                    formattedValue = formattedValue + ' ' + engUnit.trim();
                }
            } else {
                // String or other type - use as is
                formattedValue = tagValue.toString();
            }
        }
        
        // Get the emitted properties from emit() - this handles flex container properties,
        // positioning, display, visibility, element reference, and event listeners
        const emittedProps = emit({ 
            classes: ['simple-tag-display-component'] 
        });
        
        // Merge our custom container styles with the emitted styles
        // Note: We merge styles to preserve flex properties from emit() while adding our own
        // IMPORTANT: Respect the display property from emit() - if it's 'none', don't override it
        const emittedDisplay = emittedProps.style && emittedProps.style.display;
        
        // Determine vertical alignment based on row mode and verticalAlign property
        const getVerticalAlignment = () => {
            switch (verticalAlign) {
                case 'top':
                    return 'flex-start';
                case 'center':
                    return 'center';
                case 'bottom':
                    return 'flex-end';
                default:
                    return 'flex-start';
            }
        };
        
        const verticalAlignment = getVerticalAlignment();
        
        const containerStyle = {
            ...(emittedProps.style || {}),
            // Only set display: 'flex' if Perspective hasn't set display to 'none' (when display property is false)
            display: emittedDisplay === 'none' ? 'none' : 'flex',
            flexDirection: row ? 'row' : 'column',
            padding: '10px',
            borderRadius: '4px',
            backgroundColor: '#f9f9f9',
            fontFamily: 'Arial, sans-serif',
            gap: row ? '8px' : '5px',
            ...(row ? {
                alignItems: verticalAlignment
            } : {
                justifyContent: verticalAlignment,
                alignItems: 'stretch'
            })
        };
        
        // Calculate font sizes - check style.fontSize first, then fall back to auto-sizing
        const calculateFontSize = (styleObj, isValue = false) => {
            // First, check if fontSize is set in the style object
            if (styleObj && styleObj.fontSize) {
                return styleObj.fontSize;
            }
            
            // If no fontSize in style, use auto-sizing based on component dimensions
            const { componentWidth, componentHeight } = this.state;
            if (componentWidth > 0 && componentHeight > 0) {
                // Use the smaller dimension to ensure text fits
                const baseSize = Math.min(componentWidth, componentHeight);
                // For tag name, use smaller font; for value, use larger
                const multiplier = isValue ? 0.15 : 0.12; // Adjust these values to fine-tune scaling
                const calculatedSize = Math.max(8, Math.floor(baseSize * multiplier)); // Minimum 8px
                return calculatedSize + 'px';
            }
            // Fallback if dimensions not available yet
            return isValue ? '14px' : '12px';
        };
        
        // Determine width based on row and evenRow properties
        const getWidth = () => {
            if (!row) {
                return '100%'; // Full width in column mode
            }
            if (evenRow) {
                return '50%'; // Even distribution in row mode when evenRow is true
            }
            return 'auto'; // Auto width in row mode when evenRow is false
        };
        
        // Process tagNameStyle: extract classes and other CSS properties
        const tagNameStyleObj = tagNameStyle || {};
        const tagNameClasses = tagNameStyleObj.classes || '';
        // Extract all properties except 'classes' for inline styles
        const tagNameInlineStyles = {};
        Object.keys(tagNameStyleObj).forEach(key => {
            if (key !== 'classes') {
                // Convert kebab-case to camelCase (e.g., 'font-size' -> 'fontSize')
                const camelKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                tagNameInlineStyles[camelKey] = tagNameStyleObj[key];
            }
        });
        
        // Process tagValueStyle: extract classes and other CSS properties
        const tagValueStyleObj = tagValueStyle || {};
        const tagValueClasses = tagValueStyleObj.classes || '';
        // Extract all properties except 'classes' for inline styles
        const tagValueInlineStyles = {};
        Object.keys(tagValueStyleObj).forEach(key => {
            if (key !== 'classes') {
                // Convert kebab-case to camelCase (e.g., 'font-size' -> 'fontSize')
                const camelKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                tagValueInlineStyles[camelKey] = tagValueStyleObj[key];
            }
        });
        
        // Base styles for tag name label
        // Default textAlign to 'center', but check if it's set in tagNameStyle
        const baseLabelStyle = {
            fontSize: calculateFontSize(tagNameStyleObj, false),
            fontWeight: 'bold',
            color: '#333',
            transition: 'font-size 0.2s ease', // Smooth transition when size changes
            textAlign: tagNameStyleObj.textAlign || 'center', // Default to center, use style if set
            width: getWidth()
        };
        
        // Base styles for tag value label
        // Default textAlign to 'center', but check if it's set in tagValueStyle
        // When setpoint is true, show blue and pointer cursor
        const baseValueStyle = {
            fontSize: calculateFontSize(tagValueStyleObj, true),
            color: (setpoint && isConnected) ? '#0066CC' : (isConnected ? '#000' : '#999'),
            fontWeight: 'normal',
            transition: 'font-size 0.2s ease', // Smooth transition when size changes
            textAlign: tagValueStyleObj.textAlign || 'center', // Default to center, use style if set
            width: getWidth(),
            ...(setpoint ? { cursor: 'pointer' } : {})
        };
        
        // Apply bounds highlighting to value label if enabled. Thresholds come from the
        // tag's Engineering Low/High Limit (EngLow/EngHigh), read via the shared poller and
        // held in state.engLow / state.engHigh. A missing/bad limit (null) is simply not applied.
        if (bounds && bounds.enabled && isConnected && tagValue && !isNaN(tagValue)) {
            const numValue = parseFloat(tagValue);
            const { minColor, maxColor, minInclusive, maxInclusive } = bounds;
            const engLow  = this.state.engLow;
            const engHigh = this.state.engHigh;

            // Below the low limit (minInclusive=true means the limit itself is still in-range).
            const isBelowMin = (engLow != null)  && (minInclusive ? (numValue < engLow)  : (numValue <= engLow));
            // Above the high limit.
            const isAboveMax = (engHigh != null) && (maxInclusive ? (numValue > engHigh) : (numValue >= engHigh));

            if (isBelowMin) {
                baseValueStyle.backgroundColor = minColor;
            } else if (isAboveMax) {
                baseValueStyle.backgroundColor = maxColor;
            }
            // If in range, no special background (normal styling applies)
        }
        
        // Merge user-provided inline styles with base styles
        // User styles will override base styles, but base styles provide defaults
        // Note: fontSize is already handled in calculateFontSize, so if it's in inlineStyles it will override
        const labelStyle = {
            ...baseLabelStyle,
            ...tagNameInlineStyles
        };
        
        const valueStyle = {
            ...baseValueStyle,
            ...tagValueInlineStyles
        };
        
        // Format display text based on row mode
        let displayTagName = tagName;
        let displayValue = formattedValue;
        
        // In row mode, add ":" after tag name
        if (row && showTagName && showTagValue) {
            displayTagName = tagName + ':';
        }
        
        // Create the children elements with both style and className
        const children = [];
        if (showTagName) {
            children.push(React.createElement('div', { 
                style: labelStyle, 
                className: tagNameClasses || undefined,
                key: 'tagName' 
            }, displayTagName));
        }
        if (showTagValue) {
            const valueDivProps = { 
                style: valueStyle, 
                className: tagValueClasses || undefined,
                key: 'tagValue',
                onContextMenu: this.onValueContextMenu
            };
            if (setpoint) {
                valueDivProps.onClick = this.openSetpointModal;
            }
            children.push(React.createElement('div', valueDivProps, displayValue));
        }

        // Setpoint modal: backdrop (click to close) + panel with input, Close, Submit
        let modalEl = null;
        if (showSetpointModal) {
            const backdropStyle = {
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10000
            };
            const panelStyle = {
                backgroundColor: '#fff',
                padding: '24px',
                borderRadius: '8px',
                minWidth: '360px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
            };
            const titleStyle = {
                fontSize: '16px',
                fontWeight: 'bold',
                marginBottom: '16px',
                color: '#333'
            };
            const inputStyle = {
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 12px',
                marginBottom: '12px',
                fontSize: '14px',
                border: '1px solid #ccc',
                borderRadius: '4px'
            };
            const buttonStyle = {
                marginRight: '8px',
                padding: '8px 16px',
                cursor: 'pointer',
                border: '1px solid #ccc',
                borderRadius: '4px',
                backgroundColor: '#f5f5f5',
                fontSize: '14px'
            };
            const submitButtonStyle = { ...buttonStyle, backgroundColor: '#0066CC', color: '#fff', borderColor: '#0066CC' };
            const errorStyle = { color: '#c00', fontSize: '12px', marginBottom: '8px' };
            modalEl = React.createElement('div', {
                key: 'setpointBackdrop',
                style: backdropStyle,
                onClick: this.closeSetpointModal
            }, React.createElement('div', {
                style: panelStyle,
                onClick: (e) => e.stopPropagation()
            }, [
                React.createElement('div', { key: 'title', style: titleStyle }, 'Enter value for ' + tagName),
                setpointSubmitError ? React.createElement('div', { key: 'err', style: errorStyle }, setpointSubmitError) : null,
                React.createElement('input', {
                    key: 'input',
                    type: 'text',
                    inputMode: 'decimal',
                    placeholder: 'Enter value',
                    value: setpointInputValue,
                    onChange: this.onSetpointInputChange,
                    style: inputStyle,
                    autoFocus: true
                }),
                React.createElement('div', { key: 'btns', style: { display: 'flex', justifyContent: 'flex-end' } }, [
                    React.createElement('button', { key: 'close', style: buttonStyle, onClick: this.closeSetpointModal }, 'Close'),
                    React.createElement('button', { key: 'submit', style: submitButtonStyle, onClick: this.submitSetpoint }, 'Submit')
                ])
            ].filter(Boolean)));
        }

        // Right-click context menu (Trend Tag / Remove Tag when tag is historized)
        let contextMenuEl = null;
        if (contextMenuVisible && contextMenuHistorized) {
            const { contextMenuIsTrending } = this.state;
            const menuStyle = {
                position: 'fixed',
                left: contextMenuX,
                top: contextMenuY,
                zIndex: 10001,
                backgroundColor: '#fff',
                border: '1px solid #ccc',
                borderRadius: '4px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                minWidth: '120px',
                padding: '4px 0'
            };
            const itemStyle = {
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                listStyle: 'none'
            };
            const label = contextMenuIsTrending ? 'Remove Tag' : 'Trend Tag';
            const handler = contextMenuIsTrending ? this.onRemoveTagClick : this.onTrendTagClick;
            contextMenuEl = React.createElement('div', {
                key: 'contextMenu',
                style: menuStyle,
                onClick: (e) => e.stopPropagation()
            }, React.createElement('div', {
                style: itemStyle,
                onClick: (e) => { e.stopPropagation(); handler(); }
            }, label));
        }
        
        // Return the component with proper emit() spread to handle flex container properties
        // The emit() function provides: ref, style (with flex properties), className, event handlers, etc.
        // We merge our custom styles while preserving all emit() properties
        return React.createElement('div', 
            {
                ...emittedProps,
                style: containerStyle
            },
            ...children,
            modalEl,
            contextMenuEl
        );
    }
}

// Register the component
ComponentRegistry.register(new SimpleTagDisplayMeta());

/* ============================================================================
 * SECTION 2 / CtgChart (session trend chart, uPlot)
 * ----------------------------------------------------------------------------
 * Pulls per-session trend list + historian buckets + live tag values, renders
 * a multi-series line chart with custom toolbar, legend, X-Trace tooltip,
 * Pan/Zoom modes, and a date-range modal supporting both rolling-window
 * (realtime) and absolute (historical) modes.
 * ============================================================================ */

// Per-pen color cycle. Index = series order in the trend list.
const CTG_PALETTE = ['#2196F3', '#FF5722', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#F44336', '#8BC34A'];

// Allowed units in the Realtime tab of the date-range modal ("Show last N <unit>").
const CTG_ROLLING_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'];

/** Convert a rolling window (value + unit) into hours for /tagHistory's `rangeHours` param.
 *  Returns null on invalid input.
 *  @returns {number|null} */
function ctgRollingToHours(value, unit) {
    const v = parseFloat(String(value).trim());
    if (!(v > 0) || !isFinite(v)) return null;
    switch (unit) {
        case 'seconds': return v / 3600;
        case 'minutes': return v / 60;
        case 'hours':   return v;
        case 'days':    return v * 24;
        case 'weeks':   return v * 24 * 7;
        case 'months':  return v * 30 * 24;
        case 'years':   return v * 365 * 24;
        default:        return v;
    }
}

/** Format an epoch-ms timestamp into the value expected by an <input type="datetime-local">
 *  ("YYYY-MM-DDTHH:MM" in local time). Used to seed the historical tab of the date modal. */
function ctgToDatetimeLocal(ms) {
    const d = new Date(ms);
    const p2 = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/** Pluralize a unit string for the toolbar's "Last N units" preview text.
 *  `n=1` → singular ("hour"), otherwise plural ("hours"). */
function ctgPluralUnit(n, unit) {
    const x = Number(n);
    const one = x === 1;
    const map = {
        seconds: one ? 'second' : 'seconds',
        minutes: one ? 'minute' : 'minutes',
        hours:   one ? 'hour'   : 'hours',
        days:    one ? 'day'    : 'days',
        weeks:   one ? 'week'   : 'weeks',
        months:  one ? 'month'  : 'months',
        years:   one ? 'year'   : 'years',
    };
    return map[unit] || unit;
}

/** Lazy-load uPlot's CSS+JS on first chart mount. The Promise is cached so subsequent
 *  CtgChart instances reuse the already-loaded library. Resolves to the global
 *  `uPlot` constructor. Both files live under /res/simpletagdisplay/ — bundled with
 *  the module so the gateway works without internet (air-gapped sites). */
let uPlotLoaded = null;
function loadUPlot() {
    if (uPlotLoaded) return uPlotLoaded;
    uPlotLoaded = new Promise((resolve, reject) => {
        if (window.uPlot) { resolve(window.uPlot); return; }
        if (!document.getElementById('__uplot-css')) {
            const link = document.createElement('link');
            link.id = '__uplot-css';
            link.rel = 'stylesheet';
            link.href = '/res/simpletagdisplay/css/uplot.min.css';
            document.head.appendChild(link);
        }
        const script = document.createElement('script');
        script.src = '/res/simpletagdisplay/js/uplot.min.js';
        script.onload = () => resolve(window.uPlot);
        script.onerror = () => reject(new Error('Failed to load uPlot'));
        document.head.appendChild(script);
    });
    return uPlotLoaded;
}

/* -- CtgChart Perspective metadata ------------------------------------------- */

class CtgChartMeta {
    getComponentType() { return 'com.example.simpletagdisplay.CtgChart'; }
    getViewComponent() { return CtgChart; }
    getDefaultSize() { return { width: 600, height: 400 }; }
    /**
     * Props (matched against ctgchart.props.json):
     *   mode             — 'realtime' | 'historical'  (default 'realtime')
     *   rangeHours       — sliding window size in hours (default 24)
     *   pointCount       — historian bucket count (default 300)
     *   rawHistory       — pass `rawHistory=1` to /tagHistory (no aggregation)
     *   refreshRate      — silentRefresh interval in ms (default 5000)
     *   visibility.*     — toolbar control visibility toggles
     *   interaction.*    — default interaction mode + xtrace tooltip flag
     *   freeRangePanZoom — when true (default), panning/wheel-zoom in realtime
     *                      drives the historian query window (Power-Chart-like).
     */
    getPropsReducer(tree) {
        const vis = tree.read('visibility', {});
        const interaction = tree.read('interaction', {});
        return {
            mode: tree.readString('mode', 'realtime'),
            rangeHours: tree.readNumber('rangeHours', 24),
            pointCount: tree.readNumber('pointCount', 300),
            rawHistory: tree.readBoolean('rawHistory', false),
            refreshRate: tree.readNumber('refreshRate', 5000),
            visibility: {
                showModeToggle:         vis.showModeToggle !== false,
                showRangePresets:       vis.showRangePresets !== false,
                showRefreshRateControl: vis.showRefreshRateControl !== false,
                showRefreshButton:      vis.showRefreshButton !== false,
                showZoomButton:         vis.showZoomButton !== false,
                showLegend:             vis.showLegend !== false,
            },
            interaction: {
                mode: interaction.mode || 'panAndZoom',
                xTraceVisible: interaction.xTraceVisible !== false,
            },
        };
    }
}

/**
 * CtgChart — uPlot-backed trend chart.
 *
 * High-level data flow (per silentRefresh tick or initialLoad):
 *   1. fetchData()           → /trendList + /tagHistory       (historian buckets)
 *   2. fetchCurrentValues()  → /readTags (batched, chunked)   (live "now" values)
 *   3. _mergeLiveEndpoint    → append a synthetic "now" point per series so the
 *                              line keeps moving even when historian buckets
 *                              are still aligned to the previous tick
 *   4. computeStats          → per-pen Current/Min/Max/Avg for the legend
 *   5. _applyDataAndSlide    → uplot.batch( setData(false) + setScale('x', live or zoomed) )
 *
 * Why we drive the x window with explicit setScale (and `scales.x.auto: false`):
 *   - Earlier we tried a `range()` callback on scales.x. uPlot called it during
 *     drag-zoom BEFORE our setScale-hook had updated _zoomedMin/_zoomedMax, so
 *     the live-window range was returned and the user's drag was overwritten.
 *   - Driving the window only via explicit setScale keeps zoom/pan, custom date
 *     range, and the live "now" slide all on the same controlled code path.
 *
 * Instance variables (NOT React state, mutated synchronously in interaction handlers):
 *   chartEl              — DOM <div> we get a ref to in render(); uPlot mounts inside it
 *   uplot                — current uPlot instance (null between createChart / _destroyChart)
 *   refreshTimer         — setInterval handle for silentRefresh()
 *   _zoomedMin/Max       — current x viewport in SECONDS. null = follow live "now".
 *   _yMin/Max            — persistent Y range. Grows over the session, reset on initialLoad.
 *   _tooltipEl, _wrapEl  — DOM owned by us but parented inside the uPlot canvas
 *   _panState            — non-null while a drag-pan gesture is in progress
 *   _suppressScaleHook   — flag we raise around any programmatic setScale/setData call
 *                          so the setScale hook does NOT mistake it for a user gesture
 *   _customStartMs/EndMs — applied custom historical date range (ms epoch). null = no override.
 */
class CtgChart extends Component {
    constructor(props) {
        super(props);
        this.state = {
            // ----- Lifecycle / loading -------------------------------------
            status: 'loading',                // 'loading' | 'ready' | 'empty' | 'error'
            error: null,                       // string shown when status === 'error'
            // ----- Data -----------------------------------------------------
            trendListPaths: [],                // session tag list from /trendList
            lastSeries: [],                    // [{ tagPath, points: [{t,v}] }, ...] from /tagHistory
            seriesStats: [],                   // legend rows: [{ name, color, current, min, max, avg, tagPath }]
            // ----- Runtime overrides (toolbar > props) ---------------------
            runtimeMode: null,                 // null = use props.mode
            runtimeRangeHours: null,           // null = use props.rangeHours
            runtimeRefreshRate: null,          // null = use props.refreshRate
            // ----- Interaction ---------------------------------------------
            interactionMode: 'xtrace',         // 'xtrace' | 'pan' | 'zoom'
            // ----- Date range state (modal + applied window text) ----------
            customStartInput: '',              // YYYY-MM-DDTHH:MM string mirrored after apply (historical)
            customEndInput: '',
            dateRangeModalOpen: false,         // toolbar pill click opens this
            modalTab: 'realtime',              // 'realtime' | 'historical'
            modalRealtimeValue: '8',           // "Show last N <unit>" — N
            modalRealtimeUnit: 'hours',        // unit (one of CTG_ROLLING_UNITS)
            modalHistStart: '',                // <input type="datetime-local"> values
            modalHistEnd: '',
            /** Last applied rolling window (realtime); null = infer preview from getRangeHours() as hours */
            appliedRollingValue: null,         // numeric value the user typed
            appliedRollingUnit: null,          // matching unit (so toolbar pill says e.g. "Last 30 minutes")
        };
        // -------- DOM / uPlot handles (NOT React state) --------------------
        this.chartEl    = null;
        this.uplot      = null;
        this.refreshTimer = null;
        // -------- Scale tracking (seconds) ---------------------------------
        this._zoomedMin = null;          // seconds; set when user has panned/zoomed
        this._zoomedMax = null;
        this._yMin = null;               // persistent Y-range — grows but never shrinks until reset
        this._yMax = null;
        // -------- Overlay DOM owned by us ----------------------------------
        this._tooltipEl = null;
        this._wrapEl    = null;
        // -------- Interaction transients -----------------------------------
        this._panState  = null;          // { startX, scaleMin, scaleMax } while drag-panning
        this._suppressScaleHook = false; // true during setData so auto-range doesn't overwrite zoom
        // -------- Custom historical date range (ms epoch) ------------------
        this._customStartMs = null;
        this._customEndMs   = null;
    }

    /* ====================================================================
     *  Effective-value getters
     *  Toolbar runtime overrides win over Perspective props which win over
     *  hardcoded defaults. Keeps the rest of the code from worrying about
     *  precedence.
     * ==================================================================== */
    getMode()        { return this.state.runtimeMode || (this.props.props || {}).mode || 'realtime'; }
    getRangeHours()  { const r = this.state.runtimeRangeHours;  return r != null ? r : ((this.props.props || {}).rangeHours  || 24); }
    getRefreshRate() { const r = this.state.runtimeRefreshRate; return r != null ? r : ((this.props.props || {}).refreshRate || 5000); }
    getPointCount()  { return (this.props.props || {}).pointCount || 300; }
    getRawHistory()  { return !!((this.props.props || {}).rawHistory); }
    /** Like Power Chart panAndZoom.freeRange: pan/zoom drives historian time range in realtime (default on). */
    getFreeRangePanZoom() {
        const v = (this.props.props || {}).freeRangePanZoom;
        return v !== false;
    }
    getBaseUrl()     { return window.location.pathname.includes('/main/') ? '/main/data/simpletagdisplay' : '/data/simpletagdisplay'; }

    /* ====================================================================
     *  Backend I/O
     * ==================================================================== */

    /** Tiny fetch wrapper: throws on non-2xx, returns parsed JSON. */
    fetchJson(url) {
        return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    // Fetch live current values for the given tag paths via the BATCH /readTags route.
    // One request per chunk of ~40 paths instead of one /readTag per tag — same load
    // saving as the shared SimpleTagDisplay poller, applied to the chart legend's
    // "Current" column. Returns a Map of tagPath → numeric value (or null on error/bad quality).
    fetchCurrentValues(tagPaths) {
        const paths = tagPaths || this.state.trendListPaths;
        if (!paths || !paths.length) return Promise.resolve(new Map());
        const base = this.getBaseUrl();
        const CHUNK = 40;
        const chunks = [];
        for (let i = 0; i < paths.length; i += CHUNK) chunks.push(paths.slice(i, i + CHUNK));
        const requests = chunks.map(chunk => {
            const q = chunk.map(encodeURIComponent).join(',');
            return fetch(base + '/readTags?tagPaths=' + q, { credentials: 'same-origin' })
                .then(r => r.ok ? r.json() : null)
                .then(data => ({ chunk, values: (data && data.values) || {} }))
                .catch(() => ({ chunk, values: {} }));
        });
        return Promise.all(requests).then(resArr => {
            const map = new Map();
            resArr.forEach(({ chunk, values }) => {
                chunk.forEach(path => {
                    const e = values[path];
                    // Values arrive as strings; parse then require a finite number so the
                    // Map<path, number|null> contract holds (rejects "", " ", "null", "Infinity", "NaN").
                    const n = (e && e.isGood && e.value != null) ? parseFloat(e.value) : NaN;
                    map.set(path, Number.isFinite(n) ? n : null);
                });
            });
            return map;
        });
    }

    // Compute per-series stats (current, min, max, avg) for the legend table.
    // liveValues is an optional Map<tagPath, number> from fetchCurrentValues();
    // when present it overrides the last historian bucket for the Current column
    // (historian buckets lag by one interval and the last bucket is often 0).
    computeStats(series, liveValues) {
        return series.map((s, idx) => {
            const vals = (s.points || []).map(p => p.v).filter(v => v != null && !isNaN(v));
            const liveVal = liveValues && liveValues.get(s.tagPath);
            const current = liveVal != null ? liveVal : (vals.length ? vals[vals.length - 1] : null);
            const min     = vals.length ? vals.reduce((a, b) => Math.min(a, b), vals[0]) : null;
            const max     = vals.length ? vals.reduce((a, b) => Math.max(a, b), vals[0]) : null;
            const avg     = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            const name    = (s.tagPath || '').split('/').pop() || 'Tag';
            return { tagPath: s.tagPath, name, color: CTG_PALETTE[idx % CTG_PALETTE.length], current, min, max, avg };
        });
    }

    /**
     * Fetch trend list, then historian buckets for that list.
     *
     * Window selection precedence:
     *   1. _customStartMs/EndMs set    → absolute [start, end]            (historical mode)
     *   2. freeRangePanZoom + zoomed   → [zoomed window], stretched to now
     *                                    if the right edge is at "now" so live data
     *                                    keeps appending into the visible viewport
     *   3. otherwise                   → rangeHours rolling window from "now"
     */
    fetchData() {
        const base = this.getBaseUrl();
        return this.fetchJson(base + '/trendList').then(data => {
            const tagPaths = (data && data.tagPaths) || [];
            if (!tagPaths.length) return { tagPaths: [], series: [] };
            const q = tagPaths.map(x => encodeURIComponent(x)).join(',');
            let url = base + '/tagHistory?tagPaths=' + q + '&pointCount=' + this.getPointCount();
            if (this.getRawHistory()) url += '&rawHistory=1';
            const useToolbarRange = this._customStartMs != null && this._customEndMs != null;
            const useFreeViewport = this.getFreeRangePanZoom()
                && this.getMode() === 'realtime'
                && !useToolbarRange
                && this._zoomedMin != null
                && this._zoomedMax != null;

            if (useToolbarRange) {
                url += '&startTimeMs=' + this._customStartMs + '&endTimeMs=' + this._customEndMs;
            } else if (useFreeViewport) {
                let startMs = Math.round(this._zoomedMin * 1000);
                let endMs   = Math.round(this._zoomedMax * 1000);
                const nowSec = Date.now() / 1000;
                if (this._zoomedMax >= nowSec - 2) {
                    endMs = Math.max(endMs, Date.now());
                }
                if (endMs > startMs) {
                    url += '&startTimeMs=' + startMs + '&endTimeMs=' + endMs;
                } else {
                    url += '&rangeHours=' + this.getRangeHours();
                }
            } else {
                url += '&rangeHours=' + this.getRangeHours();
            }
            return this.fetchJson(url).then(h => ({ tagPaths, series: (h && h.series) || [] }));
        });
    }

    // Convert backend series [{tagPath, points:[{t(ms), v}]}] → uPlot data array.
    // uPlot format: [ timestamps_sec[], vals0[], vals1[], ... ] aligned to the same timestamp spine.
    toUPlotData(series) {
        if (!series || !series.length) return [[]];
        const tsSet = new Set();
        series.forEach(s => (s.points || []).forEach(p => { if (p.t != null) tsSet.add(p.t); }));
        const tsSorted = Array.from(tsSet).sort((a, b) => a - b);
        const tsSec    = tsSorted.map(t => t / 1000);
        const idxMap   = new Map(tsSorted.map((t, i) => [t, i]));
        const uData    = [tsSec];
        for (const s of series) {
            const arr = new Array(tsSorted.length).fill(null);
            for (const p of (s.points || [])) {
                if (p.t != null) {
                    const i = idxMap.get(p.t);
                    if (i !== undefined) arr[i] = (p.v != null && !isNaN(p.v)) ? p.v : null;
                }
            }
            uData.push(arr);
        }
        return uData;
    }

    /**
     * Historian uses bucket-aligned end times (TagHistoryQuery); between refresh ticks the
     * returned points are often identical, so the plot looks frozen. Live /readTags values
     * already update the stats table — append one point at Date.now() per tag so uPlot moves
     * on every poll (startTimer → silentRefresh at refreshRate ms).
     */
    // Append a live “now” point for realtime polish; skip when free-range viewport is entirely in the past.
    _shouldAppendLiveReadToSeries() {
        // Never in historical mode — a point at Date.now() sits outside the pinned past
        // window (invisible) yet still stretches the Y-range via expandYRange().
        if (this.getMode() !== 'realtime') return false;
        if (!this.getFreeRangePanZoom()) return true;
        if (this._zoomedMin == null || this._zoomedMax == null) return true;
        const nowSec = Date.now() / 1000;
        return this._zoomedMax >= nowSec - 2;
    }

    _mergeLiveEndpoint(series, liveValues) {
        if (!series || !series.length || !liveValues || liveValues.size === 0) return series;
        if (!this._shouldAppendLiveReadToSeries()) return series;
        const now = Date.now();
        return series.map(s => {
            const live = liveValues.get(s.tagPath);
            if (live == null || isNaN(live)) return s;
            return {
                tagPath: s.tagPath,
                points: [...(s.points || []), { t: now, v: live }],
            };
        });
    }

    // Expand the persistent Y-range to cover any new data — never shrinks on its own.
    expandYRange(series) {
        for (const s of (series || [])) {
            for (const pt of (s.points || [])) {
                if (pt.v == null || isNaN(pt.v)) continue;
                if (this._yMin === null || pt.v < this._yMin) this._yMin = pt.v;
                if (this._yMax === null || pt.v > this._yMax) this._yMax = pt.v;
            }
        }
    }

    /* ====================================================================
     *  Lifecycle: load / refresh / chart create+destroy
     * ==================================================================== */

    // Full load — shows loading spinner, recreates chart when done.
    initialLoad() {
        this.stopTimer();
        this._yMin = null;
        this._yMax = null;
        // Pin x window to custom date range when set; otherwise let range() use now.
        if (this._customStartMs != null && this._customEndMs != null) {
            this._zoomedMin = this._customStartMs / 1000;
            this._zoomedMax = this._customEndMs   / 1000;
        } else {
            this._zoomedMin = null;
            this._zoomedMax = null;
        }
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        this.setState({ status: 'loading', error: null });
        this.fetchData().then(result => Promise.all([result, this.fetchCurrentValues(result.tagPaths)]))
            .then(([{ tagPaths, series }, liveValues]) => {
                if (this._isMounted === false) return;   // discard a load that resolved after unmount
                const newStatus = tagPaths.length === 0 ? 'empty' : 'ready';
                this.setState({
                    status: newStatus,
                    trendListPaths: tagPaths,
                    lastSeries: series,
                    seriesStats: this.computeStats(series, liveValues),
                }, () => {
                    // Poll historian + live reads at refreshRate (see startTimer / silentRefresh).
                    this.startTimer();
                    // Chart mount: componentDidUpdate (→ ready) or setChartEl; reload remounts after loading.
                });
            })
            .catch(err => {
                if (this._isMounted === false) return;
                this.setState({ status: 'error', error: (err && err.message) || 'Failed to load' });
                // initialLoad() stopped the refresh timer up front; on a transient failure
                // (e.g. the gateway restarting during a module deploy) nothing would restart it,
                // leaving the chart stuck on the error screen. Schedule one full-load retry.
                if (this.getMode() === 'realtime') {
                    this._retryTimer = setTimeout(() => {
                        this._retryTimer = null;
                        if (this._isMounted !== false) this.initialLoad();
                    }, Math.max(3000, this.getRefreshRate()));
                }
            });
    }

    // Background refresh — no loading state, respects user zoom.
    silentRefresh() {
        if (this.getMode() !== 'realtime') return;
        // Fetch historian data, then live current values for the same tag set, in parallel
        this.fetchData().then(result => Promise.all([result, this.fetchCurrentValues(result.tagPaths)]))
            .then(([{ tagPaths, series }, liveValues]) => {
                if (this._isMounted === false) return;   // discard a refresh that resolved after unmount
                const wasEmpty = this.state.status === 'empty';
                const stats = this.computeStats(series, liveValues);
                this.setState({ trendListPaths: tagPaths, lastSeries: series, seriesStats: stats });

                if (wasEmpty && tagPaths.length > 0) {
                    this.setState({ status: 'ready' });
                    return;
                }

                if (!this.uplot) return;

                // If series count changed (pen added/removed), recreate the chart.
                // setData with wrong array count silently errors and stops all future updates.
                if (this.uplot.series.length - 1 !== series.length) {
                    this.createChart(this._mergeLiveEndpoint(series, liveValues));
                    return;
                }

                const chartSeries = this._mergeLiveEndpoint(series, liveValues);
                this.expandYRange(chartSeries);
                this._applyDataAndSlide(chartSeries);
            })
            .catch(() => {});
    }

    // Push new data into the chart and update the x window.
    // When the user has zoomed/panned (_zoomedMin set), hold their view.
    // Otherwise slide the window to [now - rangeHours, now] so the line advances in realtime.
    _applyDataAndSlide(series) {
        if (!this.uplot) return;
        const uData = this.toUPlotData(series);
        const plot = this.uplot;
        // Single batch => one _commit: setData(false) does not commit alone; nested setScale+commit()
        // calls are no-ops while queuedCommit is true, so batch avoids missed redraws.
        this._suppressScaleHook = true;
        plot.batch((u) => {
            u.setData(uData, false);
            if (this._zoomedMin != null) {
                u.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
            } else {
                const nowSec = Date.now() / 1000;
                u.setScale('x', { min: nowSec - this.getRangeHours() * 3600, max: nowSec });
            }
        });
        this._suppressScaleHook = false;
    }

    startTimer() {
        this.stopTimer();
        if (this.getMode() !== 'realtime') return;
        const rate = this.getRefreshRate();
        if (rate > 0) this.refreshTimer = setInterval(() => this.silentRefresh(), rate);
    }

    stopTimer() {
        if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    }

    /* ====================================================================
     *  uPlot configuration
     *  Constructed fresh on each createChart() so series count, interaction
     *  mode (cursor.drag), axis formatters, and hooks all line up.
     * ==================================================================== */

    // Build uPlot opts for the current series + interaction mode
    buildUPlotOpts(series, width, height) {
        const iMode = this.state.interactionMode;
        this.expandYRange(series);

        const uSeries = [{}];  // slot 0 = x (timestamps)
        for (let i = 0; i < series.length; i++) {
            uSeries.push({
                label: (series[i].tagPath || '').split('/').pop() || 'Tag',
                stroke: CTG_PALETTE[i % CTG_PALETTE.length],
                width: 2,
                spanGaps: false,
            });
        }

        const self = this;
        return {
            width,
            height,
            // Disable path cache so series geometry always rebuilds after setData (avoids stale frames).
            cache: false,
            series: uSeries,
            scales: {
                x: {
                    time: true,
                    // We drive the viewport only via setScale (sliding live window / zoom / pan).
                    auto: false,
                },
                y: {
                    range: (_u, dmin, dmax) => {
                        if (self._yMin !== null && self._yMax !== null) {
                            const span = self._yMax - self._yMin || Math.abs(self._yMax) || 1;
                            const pad  = span * 0.05;
                            return [self._yMin - pad, self._yMax + pad];
                        }
                        const pad = (dmax - dmin) * 0.05 || Math.abs(dmax) * 0.05 || 1;
                        return [dmin - pad, dmax + pad];
                    },
                },
            },
            axes: [
                {
                    // x-axis: HH:MM labels
                    values: (_u, vals) => vals.map(v => {
                        if (v == null) return '';
                        const d = new Date(v * 1000);
                        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
                    }),
                },
                {
                    values: (_u, vals) => vals.map(v => v != null ? Number(v).toFixed(2) : ''),
                },
            ],
            cursor: {
                show: true,
                // uPlot does assign({}, cursorOpts, { drag: { y } }, opts.cursor) — a partial `drag`
                // replaces the whole default object. Defaults include dist: 0; without it, rawDX >= drag.dist
                // is false and drag-to-zoom never arms (see uPlot mousemove selection logic).
                drag: {
                    x: iMode === 'zoom',
                    y: false,
                    setScale: iMode === 'zoom',
                    dist: 0,
                    uni: null,
                },
            },
            legend: { show: false },
            hooks: {
                setCursor: [(u) => self._updateTooltip(u)],
                // Capture user-initiated x scale changes (zoom drag, pan) into _zoomedMin/Max
                // so the range() function can preserve them across redraws.
                // _suppressScaleHook is set true during setData so the auto-range
                // recalculation doesn't get misinterpreted as a user gesture.
                setScale: [(u, key) => {
                    if (key !== 'x' || self._suppressScaleHook) return;
                    self._zoomedMin = u.scales.x.min;
                    self._zoomedMax = u.scales.x.max;
                }],
            },
        };
    }

    // Update the floating tooltip overlay using uPlot's cursor state
    _updateTooltip(u) {
        if (!this._tooltipEl) return;
        if (this.state.interactionMode !== 'xtrace') { this._tooltipEl.style.display = 'none'; return; }

        const idx = u.cursor.idx;
        if (idx == null || !u.data[0] || u.data[0].length === 0) { this._tooltipEl.style.display = 'none'; return; }

        const ts   = u.data[0][idx];
        const d    = new Date(ts * 1000);
        const p2   = n => String(n).padStart(2, '0');
        const time = d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) +
                     ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());

        const stats = this.state.seriesStats;
        let html = '<div style="font-weight:bold;margin-bottom:4px;border-bottom:1px solid #eee;padding-bottom:3px;font-size:11px">' + time + '</div>';
        for (let i = 1; i < u.series.length; i++) {
            const val       = u.data[i] ? u.data[i][idx] : null;
            const color     = CTG_PALETTE[(i - 1) % CTG_PALETTE.length];
            const name      = stats && stats[i - 1] ? stats[i - 1].name : ('Series ' + i);
            const formatted = val != null ? Number(val).toFixed(2) : '—';
            html += '<div style="display:flex;align-items:center;gap:5px">' +
                    '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0;display:inline-block"></span>' +
                    '<span>' + name + ': ' + formatted + '</span></div>';
        }
        this._tooltipEl.innerHTML = html;

        // Tooltip is parented to u.over so cursor.left/top are already in the right space.
        const cursorLeft = u.cursor.left;
        const plotW      = (u.bbox.width / (window.devicePixelRatio || 1));
        const ttW        = this._tooltipEl.offsetWidth || 160;
        const flipLeft   = cursorLeft + ttW + 20 > plotW;
        this._tooltipEl.style.left    = (flipLeft ? cursorLeft - ttW - 8 : cursorLeft + 12) + 'px';
        this._tooltipEl.style.top     = '10px';
        this._tooltipEl.style.display = 'block';
    }

    // Create (or recreate) the uPlot instance inside this.chartEl
    // opts.preserveXViewport: keep _zoomedMin/_zoomedMax (caller sets them) — used when only
    // interaction mode changes so Pan/Zoom/X-Trace do not reset the x window.
    createChart(series, opts) {
        opts = opts || {};
        const el = this.chartEl;
        if (!el) return;
        this._destroyChart();

        // uPlot's init can fire setScale hooks; if _zoomedMin gets set from that, silentRefresh
        // holds a fixed x window and the plot stops sliding with "now" until Reset Zoom clears it.
        // Default for live realtime (no custom toolbar range) is always the sliding window.
        if (!opts.preserveXViewport
            && this.getMode() === 'realtime'
            && (this._customStartMs == null || this._customEndMs == null)) {
            this._zoomedMin = null;
            this._zoomedMax = null;
        }

        loadUPlot().then(UPlot => {
            if (!el || el !== this.chartEl) return;  // stale ref

            const w    = el.clientWidth  || 600;
            const h    = el.clientHeight || 300;
            const opts = this.buildUPlotOpts(series, w, h);

            // uPlot mounts into a wrapper div so we can overlay the tooltip
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;width:100%;height:100%';
            el.appendChild(wrap);
            this._wrapEl = wrap;

            // Keep hook suppressed through ctor + first explicit setScale. If we clear suppress
            // between `new UPlot` and that setScale, init commits capture scales.x into _zoomedMin
            // and the chart freezes (Reset Zoom fixes by nulling those — match that by default).
            this._suppressScaleHook = true;
            const data = this.toUPlotData(series);
            this.uplot = new UPlot(opts, data, wrap);

            // Apply cursor style for the current mode
            const cursors = { xtrace: 'default', pan: 'grab', zoom: 'crosshair' };
            wrap.style.cursor = cursors[this.state.interactionMode] || 'default';

            // Floating tooltip overlay — parented to u.over so cursor.left is in the
            // same coordinate space with no offset calculation needed.
            this._tooltipEl = document.createElement('div');
            this._tooltipEl.style.cssText = [
                'position:absolute', 'background:rgba(255,255,255,0.95)',
                'border:1px solid #ccc', 'border-radius:4px', 'padding:6px 10px',
                'font-size:12px', 'pointer-events:none', 'display:none',
                'z-index:9999', 'white-space:nowrap',
                'box-shadow:0 2px 6px rgba(0,0,0,0.15)', 'font-family:Arial,sans-serif',
            ].join(';');
            this.uplot.over.appendChild(this._tooltipEl);
            // Allow tooltip to extend past the plot (nested views often clip overflow).
            this.uplot.over.style.overflow = 'visible';

            this._setupPanListeners(wrap);

            // Initial x window (still under suppress — hook must not treat this as user zoom).
            if (this._zoomedMin != null) {
                this.uplot.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
            } else {
                const nowSec = Date.now() / 1000;
                this.uplot.setScale('x', { min: nowSec - this.getRangeHours() * 3600, max: nowSec });
            }
            this._suppressScaleHook = false;

            requestAnimationFrame(() => {
                if (!this.uplot) return;
                this._suppressScaleHook = true;
                this._syncChartSize();
                this._suppressScaleHook = false;
            });
        }).catch(() => {
            this.setState({ status: 'error', error: 'Chart library failed to load' });
        });
    }

    _destroyChart() {
        this._teardownPanListeners();
        this._tooltipEl = null;  // removed automatically when uplot.destroy() cleans up u.over
        if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
        if (this._wrapEl) { this._wrapEl.remove(); this._wrapEl = null; }
    }

    /* ====================================================================
     *  Interaction: Pan + Wheel-zoom (only active in 'pan' interaction mode)
     *  Drag-to-zoom in 'zoom' mode is handled natively by uPlot's cursor.drag.
     * ==================================================================== */

    // Pan: mousedown+drag on the wrap div shifts the x scale; wheel on plot zooms x around cursor.
    _setupPanListeners(wrap) {
        this._teardownPanListeners();
        this._panTarget = wrap;

        this._onPanMouseDown = (e) => {
            if (this.state.interactionMode !== 'pan' || !this.uplot) return;
            e.preventDefault();
            const xs = this.uplot.scales.x;
            this._panState = { startX: e.clientX, scaleMin: xs.min, scaleMax: xs.max };
            wrap.style.cursor = 'grabbing';
        };
        this._onPanMouseMove = (e) => {
            if (!this._panState || !this.uplot) return;
            const dx    = e.clientX - this._panState.startX;
            const plotW = this.uplot.bbox.width / (window.devicePixelRatio || 1);
            const span  = this._panState.scaleMax - this._panState.scaleMin;
            const dSec  = -(dx / plotW) * span;
            this._zoomedMin = this._panState.scaleMin + dSec;
            this._zoomedMax = this._panState.scaleMax + dSec;
            this._suppressScaleHook = true;
            this.uplot.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
            this._suppressScaleHook = false;
        };
        this._onPanMouseUp = () => {
            if (!this._panState) return;
            this._panState = null;
            if (this._panTarget) this._panTarget.style.cursor = 'grab';
        };

        // Wheel zoom (x-axis) only in Pan mode — focal point follows cursor along the plot width.
        this._panWheelTarget = this.uplot && this.uplot.over;
        this._onPanWheel = (e) => {
            if (this.state.interactionMode !== 'pan' || !this.uplot) return;
            if (!e.deltaY) return;
            e.preventDefault();
            e.stopPropagation();
            const u = this.uplot;
            const xs = u.scales.x;
            if (xs.min == null || xs.max == null) return;
            const min = xs.min;
            const max = xs.max;
            const span = max - min;
            if (!(span > 0)) return;

            const dpr = window.devicePixelRatio || 1;
            const plotW = u.bbox.width / dpr;
            if (!(plotW > 0)) return;
            const rect = u.over.getBoundingClientRect();
            let rx = (e.clientX - rect.left) / plotW;
            if (rx < 0) rx = 0;
            if (rx > 1) rx = 1;

            // Trackpad sends smaller deltas; normalize roughly to one "notch" ~ 100.
            const step = 0.12 * Math.min(2.5, Math.max(1, Math.abs(e.deltaY) / 100));
            // deltaY > 0: scroll down → zoom out (wider window). deltaY < 0: zoom in.
            const factor = e.deltaY > 0 ? (1 + step) : (1 / (1 + step));
            let newSpan = span * factor;
            const minSpan = Math.max(1, span / 400);
            const maxSpan = Math.min(span * 800, 10 * 365 * 24 * 3600);
            newSpan = Math.max(minSpan, Math.min(maxSpan, newSpan));

            const focal = min + rx * span;
            const newMin = focal - rx * newSpan;
            const newMax = focal + (1 - rx) * newSpan;

            this._zoomedMin = newMin;
            this._zoomedMax = newMax;
            this._suppressScaleHook = true;
            u.setScale('x', { min: newMin, max: newMax });
            this._suppressScaleHook = false;
        };

        wrap.addEventListener('mousedown', this._onPanMouseDown);
        window.addEventListener('mousemove', this._onPanMouseMove);
        window.addEventListener('mouseup',   this._onPanMouseUp);
        if (this._panWheelTarget && this._onPanWheel) {
            this._panWheelTarget.addEventListener('wheel', this._onPanWheel, { passive: false });
        }
    }

    _teardownPanListeners() {
        if (this._panWheelTarget && this._onPanWheel) {
            this._panWheelTarget.removeEventListener('wheel', this._onPanWheel);
            this._panWheelTarget = null;
            this._onPanWheel = null;
        }
        if (this._panTarget) {
            if (this._onPanMouseDown) this._panTarget.removeEventListener('mousedown', this._onPanMouseDown);
            this._panTarget = null;
        }
        if (this._onPanMouseMove) window.removeEventListener('mousemove', this._onPanMouseMove);
        if (this._onPanMouseUp)   window.removeEventListener('mouseup',   this._onPanMouseUp);
        this._panState = null;
    }

    // Ref callback — fires when the chart container div mounts or unmounts
    setChartEl = (el) => {
        if (el) {
            this.chartEl = el;
            // First paint: componentDidUpdate also builds the chart (avoids double createChart).
        } else {
            // The chart div is being unmounted (e.g. an initialLoad() loading→ready cycle
            // remounts a fresh node). Detach the ResizeObserver from the old node and clear
            // the attach latch so componentDidUpdate re-observes the NEW node — otherwise
            // auto-resize silently stops working after the first reload.
            if (this._resizeObserver && this.chartEl) {
                this._resizeObserver.unobserve(this.chartEl);
            }
            this._roAttached = false;
            this._destroyChart();
            this.chartEl = null;
            this.stopTimer();
        }
    };

    _syncChartSize() {
        if (!this.uplot || !this.chartEl) return;
        const w = this.chartEl.clientWidth;
        const h = this.chartEl.clientHeight;
        if (w > 0 && h > 0 && (w !== this.uplot.width || h !== this.uplot.height)) {
            // setSize can trigger uPlot's x setScale internally; without suppress, the setScale
            // hook treats that as user zoom and locks _zoomedMin/_zoomedMax — live view stops
            // sliding until Reset zoom (ResizeObserver often fires after add/remove pen).
            const prevSuppress = this._suppressScaleHook;
            this._suppressScaleHook = true;
            try {
                this.uplot.setSize({ width: w, height: h });
            } finally {
                this._suppressScaleHook = prevSuppress;
            }
        }
    }

    /* ====================================================================
     *  React lifecycle
     * ==================================================================== */

    componentDidMount() {
        this._isMounted = true;
        this.initialLoad();
        // React to tag add/remove events fired by SimpleTagDisplay components on this page.
        this._onTrendListChanged = () => this.initialLoad();
        window.addEventListener('ctg-trend-list-changed', this._onTrendListChanged);
        if (window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(() => this._syncChartSize());
        }
    }

    componentDidUpdate(prevProps, prevState) {
        const prevMode = prevState.runtimeMode !== null ? prevState.runtimeMode : ((prevProps.props || {}).mode || 'realtime');
        const prevRate = prevState.runtimeRefreshRate != null ? prevState.runtimeRefreshRate : ((prevProps.props || {}).refreshRate || 5000);
        if ((prevMode !== this.getMode() || prevRate !== this.getRefreshRate()) && this.uplot) {
            this.startTimer();
        }
        // Mount chart after loading/empty → ready (ref may run in the same commit).
        if (prevState.status !== 'ready' && this.state.status === 'ready' && this.chartEl && !this.uplot) {
            this.fetchCurrentValues(this.state.trendListPaths).then(live => {
                if (!this.chartEl || this.uplot || this.state.status !== 'ready') return;
                this.createChart(this._mergeLiveEndpoint(this.state.lastSeries, live));
            });
        }
        // Attach ResizeObserver once chartEl is available
        if (this._resizeObserver && this.chartEl && !this._roAttached) {
            this._resizeObserver.observe(this.chartEl);
            this._roAttached = true;
        }
    }

    componentWillUnmount() {
        this._isMounted = false;
        this.stopTimer();
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        this._destroyChart();
        window.removeEventListener('ctg-trend-list-changed', this._onTrendListChanged);
        if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    }

    /* ====================================================================
     *  Toolbar / user-action handlers
     * ==================================================================== */

    // --- User action handlers ---
    handleRefreshRateChange = (val)   => {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && parsed >= 0) this.setState({ runtimeRefreshRate: parsed }, () => { if (this.uplot) this.startTimer(); });
    };
    handleManualRefresh = () => this.initialLoad();

    getDateRangePreviewText() {
        if (this.getMode() === 'historical' && this._customStartMs != null && this._customEndMs != null) {
            const a = new Date(this._customStartMs);
            const b = new Date(this._customEndMs);
            const o = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
            return a.toLocaleString(undefined, o) + ' – ' + b.toLocaleString(undefined, o);
        }
        const u = this.state.appliedRollingUnit || 'hours';
        const v = this.state.appliedRollingValue != null
            ? this.state.appliedRollingValue
            : this.getRangeHours();
        const displayV = typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
        return 'Last ' + displayV + ' ' + ctgPluralUnit(displayV, u);
    }

    openDateRangeModal = () => {
        const mode = this.getMode();
        const histActive = mode === 'historical' && this._customStartMs != null && this._customEndMs != null;
        const tab = histActive ? 'historical' : 'realtime';
        let modalRealtimeValue = '8';
        let modalRealtimeUnit = 'hours';
        if (!histActive) {
            if (this.state.appliedRollingValue != null && this.state.appliedRollingUnit) {
                modalRealtimeValue = String(this.state.appliedRollingValue);
                modalRealtimeUnit = this.state.appliedRollingUnit;
            } else {
                const h = this.getRangeHours();
                modalRealtimeValue = String(Math.round(h * 1000000) / 1000000);
                modalRealtimeUnit = 'hours';
            }
        }
        let modalHistStart = this.state.modalHistStart;
        let modalHistEnd = this.state.modalHistEnd;
        if (this._customStartMs != null && this._customEndMs != null) {
            modalHistStart = ctgToDatetimeLocal(this._customStartMs);
            modalHistEnd = ctgToDatetimeLocal(this._customEndMs);
        } else if (!modalHistStart || !modalHistEnd) {
            const now = Date.now();
            modalHistStart = ctgToDatetimeLocal(now - 24 * 3600 * 1000);
            modalHistEnd = ctgToDatetimeLocal(now);
        }
        this.setState({
            dateRangeModalOpen: true,
            modalTab: tab,
            modalRealtimeValue,
            modalRealtimeUnit,
            modalHistStart,
            modalHistEnd,
        });
    };

    closeDateRangeModal = () => this.setState({ dateRangeModalOpen: false });

    applyDateRangeModal = () => {
        if (this.state.modalTab === 'realtime') {
            const hours = ctgRollingToHours(this.state.modalRealtimeValue, this.state.modalRealtimeUnit);
            if (hours == null || hours <= 0) return;
            const val = parseFloat(String(this.state.modalRealtimeValue).trim());
            this._customStartMs = null;
            this._customEndMs = null;
            this.setState({
                runtimeMode: 'realtime',
                runtimeRangeHours: hours,
                appliedRollingValue: val,
                appliedRollingUnit: this.state.modalRealtimeUnit,
                customStartInput: '',
                customEndInput: '',
                dateRangeModalOpen: false,
            }, () => this.initialLoad());
        } else {
            const startMs = new Date(this.state.modalHistStart).getTime();
            const endMs = new Date(this.state.modalHistEnd).getTime();
            if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) return;
            this._customStartMs = startMs;
            this._customEndMs = endMs;
            this.setState({
                runtimeMode: 'historical',
                customStartInput: this.state.modalHistStart,
                customEndInput: this.state.modalHistEnd,
                dateRangeModalOpen: false,
            }, () => this.initialLoad());
        }
    };

    handleRemovePen = (tagPath) => {
        const url = this.getBaseUrl() + '/removeFromTrendList?tagPath=' + encodeURIComponent(tagPath);
        fetch(url, { method: 'GET', credentials: 'same-origin' }).finally(() => this.initialLoad());
    };

    resetZoom = () => {
        if (!this.uplot) return;
        // Restore to the custom date range if one is applied, otherwise go live.
        if (this._customStartMs != null && this._customEndMs != null) {
            this._zoomedMin = this._customStartMs / 1000;
            this._zoomedMax = this._customEndMs   / 1000;
        } else {
            this._zoomedMin = null;
            this._zoomedMax = null;
        }
        this._yMin = null;
        this._yMax = null;
        const plot = this.uplot;
        this.fetchCurrentValues(this.state.trendListPaths).then(live => {
            if (!this.uplot || this.uplot !== plot) return;
            const chartSeries = this._mergeLiveEndpoint(this.state.lastSeries, live);
            this.expandYRange(chartSeries);
            const uData = this.toUPlotData(chartSeries);
            this._suppressScaleHook = true;
            this.uplot.batch((u) => {
                u.setData(uData, false);
                if (this._zoomedMin != null) {
                    u.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
                } else {
                    const nowSec = Date.now() / 1000;
                    u.setScale('x', { min: nowSec - this.getRangeHours() * 3600, max: nowSec });
                }
            });
            this._suppressScaleHook = false;
        });
    };

    handleInteractionModeChange = (iMode) => {
        this._panState = null;
        let xMin = null, xMax = null;
        if (this.uplot && this.uplot.scales.x) {
            const x = this.uplot.scales.x;
            const min = x.min, max = x.max;
            if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max) && max > min) {
                xMin = min;
                xMax = max;
            }
        }
        this.setState({ interactionMode: iMode }, () => {
            if (!this.chartEl || !this.uplot) return;
            if (xMin == null || xMax == null) {
                const x = this.uplot.scales.x;
                const min = x.min, max = x.max;
                if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max) && max > min) {
                    xMin = min;
                    xMax = max;
                }
            }
            this.fetchCurrentValues(this.state.trendListPaths).then(live => {
                if (!this.chartEl) return;
                const preserve = xMin != null && xMax != null;
                if (preserve) {
                    this._zoomedMin = xMin;
                    this._zoomedMax = xMax;
                }
                this.createChart(this._mergeLiveEndpoint(this.state.lastSeries, live), { preserveXViewport: preserve });
            });
        });
    };

    /* ====================================================================
     *  Render helpers (toolbar pill icons, date-range modal, toolbar, legend)
     * ==================================================================== */

    // --- Render helpers ---
    ctgDateRangeIcon() {
        return React.createElement('svg', {
            width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': true,
            style: { flexShrink: 0 },
        },
            React.createElement('path', {
                fill: '#1976D2',
                d: 'M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zm0 5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H7zm8 5.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zm-3.5 1.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
            }),
        );
    }

    ctgChevronDownIcon() {
        return React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 12 12', style: { flexShrink: 0 } },
            React.createElement('path', { fill: '#1976D2', d: 'M2.5 4.5L6 8l3.5-3.5H2.5z' }),
        );
    }

    renderDateRangeModal() {
        if (!this.state.dateRangeModalOpen) return null;
        const tab = this.state.modalTab;
        const inp = { padding: '6px 8px', fontSize: '13px', border: '1px solid #ccc', borderRadius: 4 };
        const inpRt = {
            padding: '5px 8px', fontSize: '12px', border: '1px solid #c5c5c5', borderRadius: 4,
            background: '#fff', color: '#333', boxSizing: 'border-box',
        };
        const tabBase = { flex: 1, padding: '10px 12px', fontSize: '13px', cursor: 'pointer', border: 'none', background: 'transparent', fontWeight: 600 };
        const tabActive = { ...tabBase, color: '#222', borderBottom: '3px solid #2196F3', marginBottom: '-2px' };
        const tabIdle = { ...tabBase, color: '#888', borderBottom: '3px solid transparent' };
        const btnCancel = { padding: '8px 18px', fontSize: '13px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: 4, background: '#fff' };
        const btnApply = { padding: '8px 18px', fontSize: '13px', cursor: 'pointer', border: '1px solid #1976D2', borderRadius: 4, background: '#2196F3', color: '#fff', fontWeight: 600 };

        const modalWidth = tab === 'realtime'
            ? 'min(320px, calc(100vw - 32px))'
            : 'min(440px, calc(100vw - 32px))';

        return React.createElement('div', {
            key: 'date-range-overlay',
            style: {
                position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.35)', zIndex: 20000,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            },
            onClick: this.closeDateRangeModal,
        },
            React.createElement('div', {
                style: {
                    background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                    width: modalWidth, maxHeight: 'calc(100vh - 48px)', overflow: 'hidden',
                },
                onClick: (e) => e.stopPropagation(),
            },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#424242', color: '#fff', padding: '10px 14px' } },
                    React.createElement('span', { style: { fontSize: '14px', fontWeight: 600 } }, 'Set Date Range'),
                    React.createElement('button', {
                        type: 'button',
                        onClick: this.closeDateRangeModal,
                        style: { border: 'none', background: 'transparent', color: '#fff', fontSize: '20px', lineHeight: 1, cursor: 'pointer', padding: '0 4px' },
                    }, '×'),
                ),
                React.createElement('div', { style: { display: 'flex', borderBottom: '1px solid #e0e0e0' } },
                    React.createElement('button', {
                        type: 'button', style: tab === 'realtime' ? tabActive : tabIdle,
                        onClick: () => this.setState({ modalTab: 'realtime' }),
                    }, 'Realtime'),
                    React.createElement('button', {
                        type: 'button', style: tab === 'historical' ? tabActive : tabIdle,
                        onClick: () => this.setState({ modalTab: 'historical' }),
                    }, 'Historical'),
                ),
                React.createElement('div', {
                    style: tab === 'realtime'
                        ? { padding: '20px 20px 18px', textAlign: 'center' }
                        : { padding: '16px 18px', minHeight: 140 },
                },
                    tab === 'realtime'
                        ? React.createElement('div', {
                            style: {
                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
                                maxWidth: 260, margin: '0 auto',
                            },
                        },
                            React.createElement('span', {
                                style: { fontSize: '11px', color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' },
                            }, 'Rolling window'),
                            React.createElement('div', {
                                style: {
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    flexWrap: 'wrap', gap: '6px 8px', width: '100%',
                                },
                            },
                                React.createElement('span', { style: { fontSize: '12px', color: '#444' } }, 'Show last'),
                                React.createElement('input', {
                                    type: 'number', min: 0.001, step: 'any',
                                    value: this.state.modalRealtimeValue,
                                    onChange: e => this.setState({ modalRealtimeValue: e.target.value }),
                                    style: { ...inpRt, width: 56, textAlign: 'center' },
                                }),
                                React.createElement('select', {
                                    value: this.state.modalRealtimeUnit,
                                    onChange: e => this.setState({ modalRealtimeUnit: e.target.value }),
                                    style: { ...inpRt, minWidth: 0, width: 'auto', maxWidth: 118, cursor: 'pointer' },
                                }, ...CTG_ROLLING_UNITS.map(u =>
                                    React.createElement('option', { key: u, value: u }, u.charAt(0).toUpperCase() + u.slice(1)),
                                )),
                            ),
                        )
                        : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
                            React.createElement('label', { style: { fontSize: '12px', color: '#555' } }, 'Start',
                                React.createElement('input', {
                                    type: 'datetime-local',
                                    value: this.state.modalHistStart,
                                    onChange: e => this.setState({ modalHistStart: e.target.value }),
                                    style: { ...inp, display: 'block', width: '100%', marginTop: 4, colorScheme: 'light' },
                                }),
                            ),
                            React.createElement('label', { style: { fontSize: '12px', color: '#555' } }, 'End',
                                React.createElement('input', {
                                    type: 'datetime-local',
                                    value: this.state.modalHistEnd,
                                    onChange: e => this.setState({ modalHistEnd: e.target.value }),
                                    style: { ...inp, display: 'block', width: '100%', marginTop: 4, colorScheme: 'light' },
                                }),
                            ),
                        ),
                ),
                React.createElement('div', {
                    style: {
                        display: 'flex', justifyContent: 'flex-end', gap: 8,
                        padding: tab === 'realtime' ? '10px 16px 14px' : '12px 18px 16px',
                        borderTop: '1px solid #eee', background: '#fafafa',
                    },
                },
                    React.createElement('button', { type: 'button', style: btnCancel, onClick: this.closeDateRangeModal }, 'Cancel'),
                    React.createElement('button', { type: 'button', style: btnApply, onClick: this.applyDateRangeModal }, 'Apply'),
                ),
            ),
        );
    }

    renderToolbar() {
        const vis = ((this.props.props || {}).visibility) || {};
        const { status } = this.state;
        const mode        = this.getMode();
        const refreshRate = this.getRefreshRate();

        const tb  = { flexShrink: 0, padding: '6px 10px', fontSize: '12px', background: '#f0f0f0', borderBottom: '1px solid #ccc', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', userSelect: 'none' };
        const btn = { padding: '3px 8px', fontSize: '12px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: 3, background: '#fff', lineHeight: '1.4' };
        const abn = { ...btn, background: '#2196F3', color: '#fff', borderColor: '#1976D2' };
        const sep = (k) => React.createElement('span', { key: k, style: { display: 'inline-block', width: 1, height: 16, background: '#ccc', margin: '0 4px' } });
        const lbl = (t, k) => React.createElement('span', { key: k, style: { fontSize: '11px', color: '#666' } }, t);

        const iMode = this.state.interactionMode;
        const left = [];

        const showDateRange = vis.showRangePresets !== false || vis.showModeToggle !== false;
        if (showDateRange) {
            left.push(React.createElement('button', {
                key: 'datePreview',
                type: 'button',
                onClick: this.openDateRangeModal,
                style: {
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    padding: '4px 10px 4px 6px', fontSize: '13px', fontWeight: 600,
                    color: '#1976D2', background: '#fff', border: '1px solid #90caf9', borderRadius: 4,
                    cursor: 'pointer', lineHeight: 1.3,
                },
            },
                this.ctgDateRangeIcon(),
                React.createElement('span', null, this.getDateRangePreviewText()),
                this.ctgChevronDownIcon(),
            ));
            left.push(sep('sDr'));
        }

        if (vis.showRefreshRateControl !== false && mode === 'realtime') {
            left.push(lbl('Refresh:', 'lrr'));
            left.push(React.createElement('input', {
                key: 'rri', type: 'number', min: 0, step: 1000, value: refreshRate,
                onChange: e => this.handleRefreshRateChange(e.target.value),
                style: { width: 65, padding: '2px 4px', fontSize: '12px', border: '1px solid #ccc', borderRadius: 3 },
            }));
            left.push(lbl('ms', 'lrrms'));
        }

        left.push(sep('s3'));
        left.push(lbl('Interact:', 'li'));
        left.push(React.createElement('button', { key: 'iXT',   style: iMode === 'xtrace' ? abn : btn, onClick: () => this.handleInteractionModeChange('xtrace') }, 'X-Trace'));
        left.push(React.createElement('button', { key: 'iPan',  style: iMode === 'pan'    ? abn : btn, onClick: () => this.handleInteractionModeChange('pan')    }, 'Pan'));
        left.push(React.createElement('button', { key: 'iZoom', style: iMode === 'zoom'   ? abn : btn, onClick: () => this.handleInteractionModeChange('zoom')   }, 'Zoom'));

        const right = [];
        if (vis.showRefreshButton !== false) {
            right.push(React.createElement('button', { key: 'ref',  style: btn, onClick: this.handleManualRefresh }, '↺ Refresh'));
        }
        if (vis.showZoomButton !== false && status === 'ready') {
            right.push(React.createElement('button', { key: 'zoom', style: btn, onClick: this.resetZoom }, 'Reset zoom'));
        }

        return React.createElement('div', { key: 'toolbar', style: tb },
            ...left,
            React.createElement('div', { style: { flex: 1 } }),
            ...right,
        );
    }

    renderLegend() {
        const vis = ((this.props.props || {}).visibility) || {};
        const { seriesStats } = this.state;
        if (vis.showLegend === false || !seriesStats || !seriesStats.length) return null;

        const fmt = v => v != null ? Number(v).toFixed(2) : '—';
        const th = (t, k, align) => React.createElement('th', { key: k, style: { padding: '4px 10px', textAlign: align || 'right', color: '#888', fontWeight: 600, fontSize: '11px', borderBottom: '1px solid #e0e0e0', whiteSpace: 'nowrap' } }, t);
        const td = (t, k, extra) => React.createElement('td', { key: k, style: { padding: '4px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '12px', ...(extra || {}) } }, t);

        return React.createElement('div', { key: 'legend', style: { flexShrink: 0, fontSize: '12px', borderTop: '1px solid #e0e0e0', background: '#fafafa', overflowX: 'auto', maxHeight: 120, overflowY: 'auto' } },
            React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                React.createElement('thead', null,
                    React.createElement('tr', null, th('Tag', 'h0', 'left'), th('Current', 'h1'), th('Min', 'h2'), th('Max', 'h3'), th('Avg', 'h4'), th('', 'h5'))
                ),
                React.createElement('tbody', null,
                    ...seriesStats.map((s, i) =>
                        React.createElement('tr', { key: i },
                            React.createElement('td', { style: { padding: '4px 10px', whiteSpace: 'nowrap' } },
                                React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                                    React.createElement('span', { style: { width: 10, height: 10, borderRadius: '50%', background: s.color, display: 'inline-block', flexShrink: 0 } }),
                                    s.name,
                                )
                            ),
                            td(fmt(s.current), 'c' + i),
                            td(fmt(s.min),     'm' + i),
                            td(fmt(s.max),     'x' + i),
                            td(fmt(s.avg),     'a' + i),
                            React.createElement('td', { key: 'rm' + i, style: { padding: '0 6px', textAlign: 'center', width: 24 } },
                                React.createElement('button', {
                                    title: 'Remove pen',
                                    onClick: () => this.handleRemovePen(s.tagPath),
                                    style: { background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: '14px', lineHeight: 1, padding: '2px 4px', borderRadius: 3 },
                                    onMouseEnter: (e) => { e.currentTarget.style.color = '#c00'; },
                                    onMouseLeave: (e) => { e.currentTarget.style.color = '#aaa'; },
                                }, '×')
                            ),
                        )
                    )
                )
            )
        );
    }

    render() {
        const { emit } = this.props;
        const emittedProps = emit ? emit({ classes: ['ctg-chart-component'] }) : {};
        const { status, error } = this.state;
        const emittedDisplay = emittedProps.style && emittedProps.style.display;
        const containerStyle = {
            ...(emittedProps.style || {}),
            display: emittedDisplay === 'none' ? 'none' : 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: '#fff',
        };

        let body;
        if (status === 'loading') {
            body = React.createElement('div', { key: 'body-loading', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' } }, 'Loading…');
        } else if (status === 'error') {
            body = React.createElement('div', { key: 'body-error', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c00', padding: 16, textAlign: 'center' } }, error || 'Error');
        } else if (status === 'empty') {
            body = React.createElement('div', { key: 'body-empty', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', padding: 16, textAlign: 'center' } },
                'No tags in trend list. Right-click a historized tag value → Trend Tag.');
        } else {
            body = React.createElement('div', { key: 'body-chart', ref: this.setChartEl, style: { flex: 1, minHeight: 0, overflow: 'hidden' } });
        }

        return React.createElement('div', { ...emittedProps, style: containerStyle },
            this.renderToolbar(),
            body,
            status === 'ready' ? this.renderLegend() : null,
            this.renderDateRangeModal(),
        );
    }
}

ComponentRegistry.register(new CtgChartMeta());
