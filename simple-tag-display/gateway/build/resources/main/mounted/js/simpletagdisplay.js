/**
 * Tag Display Component for Ignition Perspective
 * A component that displays tag names and values with automatic tag path parsing.
 */

const { Component, ComponentRegistry } = window.PerspectiveClient;

// Inject CSS once to allow ApexCharts tooltips to render outside the chart canvas bounds.
// ApexCharts hard-codes overflow:hidden on .apexcharts-canvas via its own stylesheet,
// which clips the tooltip when it appears near the bottom or edges of the chart.
(function injectCtgStyles() {
    const id = '__ctg-apex-styles';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = [
        '.apexcharts-tooltip { z-index: 9999 !important; }',
        '.apexcharts-xaxistooltip { z-index: 9999 !important; }',
        // canvas stays clipped — tooltip is pinned to 35% so it never reaches the canvas edge
        // In X-Trace mode: lock tooltip vertically to ~middle of the plot area.
        // ApexCharts sets top via inline style; stylesheet !important beats it.
        // 35% of the canvas height ≈ center of the plot region (axis labels occupy top/bottom).
        '.ctg-xtrace-active .apexcharts-tooltip { top: 35% !important; }',
        // Hide ApexCharts' built-in toolbar — we use our own interaction mode buttons
        '.ctg-pan-active .apexcharts-toolbar { display: none !important; }',
        '.ctg-zoom-active .apexcharts-toolbar { display: none !important; }',
        '.ctg-xtrace-active .apexcharts-toolbar { display: none !important; }',
        // Cursor styling for pan mode — grabbing while dragging
        '.ctg-pan-active .apexcharts-canvas { cursor: grab !important; }',
        '.ctg-pan-active .apexcharts-canvas:active { cursor: grabbing !important; }',
        // Cursor for zoom mode
        '.ctg-zoom-active .apexcharts-canvas { cursor: crosshair !important; }',
        // Default cursor for X-Trace mode
        '.ctg-xtrace-active .apexcharts-canvas { cursor: default !important; }',
    ].join('\n');
    document.head.appendChild(s);
})();

/**
 * Component Meta Object - contains information about the component
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
        return {
            tagPath: tree.readString("tagPath", ""),
            showTagName: tree.readBoolean("showTagName", true),
            showTagValue: tree.readBoolean("showTagValue", true),
            tagNameLabel: tree.readString("tagNameLabel", ""),
            valuePrecision: tree.readNumber("valuePrecision", 1),
            row: tree.readBoolean("row", false),
            evenRow: tree.readBoolean("evenRow", false),
            verticalAlign: tree.readString("verticalAlign", "top"),
            showUnits: tree.readBoolean("showUnits", false),
            boolean: tree.read("boolean", {
                textOnTrue: "",
                textOnFalse: ""
            }),
            bounds: tree.read("bounds", {
                enabled: false,
                min: 0,
                max: 100,
                minColor: "#FF0000",
                maxColor: "#00FF00",
                minInclusive: false,
                maxInclusive: false
            }),
            setpoint: tree.readBoolean("setpoint", false),
            tagNameStyle: tree.read("tagNameStyle", { classes: "" }),
            tagValueStyle: tree.read("tagValueStyle", { classes: "" })
        };
    }
}

/**
 * The Tag Display Component implementation
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
            contextMenuHistorized: false,
            contextMenuIsTrending: false
        };
        this.pollInterval = null;
        this.engUnitInterval = null;
        this.componentRef = null;
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
                        this.readTagValue();
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
        ]).then(() => this.closeContextMenu());
    };

    onRemoveTagClick = () => {
        const { tagPath } = this.props.props;
        if (!tagPath || !tagPath.trim()) { this.closeContextMenu(); return; }
        const trimmedPath = tagPath.trim();
        this._fetchFirstWorking([
            '/data/simpletagdisplay/removeFromTrendList?tagPath=' + encodeURIComponent(trimmedPath),
            '/main/data/simpletagdisplay/removeFromTrendList?tagPath=' + encodeURIComponent(trimmedPath)
        ]).then(() => this.closeContextMenu());
    };

    componentDidMount() {
        this.boundCloseContextMenu = () => this.closeContextMenu();
        // Start polling for tag value
        this.startPolling();
        // Set up resize observer for auto font sizing
        // Use setTimeout to ensure element is available after render
        setTimeout(() => {
            this.setupSizeTracking();
        }, 0);
    }
    
    setupSizeTracking() {
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
        document.removeEventListener('click', this.boundCloseContextMenu);
        // Stop polling when component is removed
        this.stopPolling();
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
            setTimeout(() => document.addEventListener('click', this.boundCloseContextMenu), 0);
        }
        if (!this.state.contextMenuVisible && prevState.contextMenuVisible) {
            document.removeEventListener('click', this.boundCloseContextMenu);
        }
        // Restart polling if tagPath changed
        if (prevProps.props.tagPath !== this.props.props.tagPath) {
            this.stopPolling();
            this.startPolling();
        }
        // Update component size if font properties changed
        if (prevProps.props.tagNameFont !== this.props.props.tagNameFont ||
            prevProps.props.tagValueFont !== this.props.props.tagValueFont) {
            this.updateComponentSize();
        }
        // Handle EngUnit polling when showUnits or tagPath changes
        if (prevProps.props.showUnits !== this.props.props.showUnits ||
            prevProps.props.tagPath !== this.props.props.tagPath) {
            // Stop existing EngUnit polling
            if (this.engUnitInterval) {
                clearInterval(this.engUnitInterval);
                this.engUnitInterval = null;
            }
            
            if (this.props.props.showUnits && this.props.props.tagPath) {
                // Start EngUnit polling
                this.readEngUnit(); // Read immediately
                this.engUnitInterval = setInterval(() => {
                    if (this.props.props.showUnits && this.props.props.tagPath) {
                        this.readEngUnit();
                    }
                }, 5000); // Poll every 5 seconds
            } else {
                // Clear EngUnit if showUnits is disabled
                this.setState({ engUnit: '' });
            }
        }
    }

    startPolling() {
        this.readTagValue(); // Read immediately
        // Poll every 250ms for faster updates (4 times per second)
        // This provides near-instant updates while still being reasonable for server load
        this.pollInterval = setInterval(() => this.readTagValue(), 250);
        
        // Also read EngUnit if showUnits is enabled
        // EngUnits rarely change, so poll less frequently (every 5 seconds)
        if (this.props.props.showUnits && this.props.props.tagPath) {
            this.readEngUnit(); // Read immediately
            this.engUnitInterval = setInterval(() => {
                if (this.props.props.showUnits && this.props.props.tagPath) {
                    this.readEngUnit();
                }
            }, 5000); // Poll every 5 seconds
        }
    }

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.engUnitInterval) {
            clearInterval(this.engUnitInterval);
            this.engUnitInterval = null;
        }
    }

    readTagValue() {
        const { props } = this.props;
        const { tagPath } = props;

        if (!tagPath || !tagPath.trim()) {
            this.setState({ tagValue: 'No Tag Path', isConnected: false });
            return;
        }

        // Based on the official example, routes are accessible at /data/{URL_ALIAS}/{route}
        // The example uses /data/radcomponents/component/tagcount (without /main/)
        // So we should use /data/simpletagdisplay/readTag
        const urlsToTry = [
            `/data/simpletagdisplay/readTag?tagPath=${encodeURIComponent(tagPath)}`,
            `/main/data/simpletagdisplay/readTag?tagPath=${encodeURIComponent(tagPath)}`
        ];
        
        // Try each URL in sequence
        const tryFetch = (urlIndex) => {
            if (urlIndex >= urlsToTry.length) {
                this.setState({ 
                    tagValue: 'Error: All endpoint paths failed. Check gateway logs.', 
                    isConnected: false 
                });
                return;
            }
            
            const url = urlsToTry[urlIndex];
            
            fetch(url)
                .then(response => {
                    if (!response.ok) {
                        if (response.status === 404 && urlIndex < urlsToTry.length - 1) {
                            // Try next URL
                            console.log(`404 on ${url}, trying next...`);
                            return tryFetch(urlIndex + 1);
                        }
                        console.error(`Failed to fetch from: ${url}, status: ${response.status}`);
                        throw new Error(`HTTP error! status: ${response.status}, URL: ${url}`);
                    }
                    const contentType = response.headers.get("content-type");
                    if (!contentType || !contentType.includes("application/json")) {
                        return response.text().then(text => {
                            console.error(`Expected JSON but got: ${text.substring(0, 100)}`);
                            throw new Error(`Expected JSON but got: ${text.substring(0, 100)}`);
                        });
                    }
                    return response.json();
                })
                .then(data => {
                    if (data && data.success !== undefined) {
                        if (data.success && data.isGood) {
                            this.setState({ tagValue: data.value, isConnected: true });
                        } else {
                            this.setState({ tagValue: data.error || 'Bad Quality', isConnected: false });
                        }
                    } else {
                        // Not a valid response, try next URL
                        if (urlIndex < urlsToTry.length - 1) {
                            return tryFetch(urlIndex + 1);
                        }
                        throw new Error('Invalid response format');
                    }
                })
                .catch(error => {
                    if (urlIndex < urlsToTry.length - 1 && error.message.includes('404')) {
                        // Try next URL on 404
                        return tryFetch(urlIndex + 1);
                    }
                    this.setState({ tagValue: 'Error: ' + error.message, isConnected: false });
                });
        };
        
        // Start trying from the first URL
        tryFetch(0);
    }
    
    readEngUnit() {
        const { props } = this.props;
        const { tagPath } = props;

        if (!tagPath || !tagPath.trim()) {
            this.setState({ engUnit: '' });
            return;
        }

        // Append .EngUnit to the tag path
        const engUnitPath = tagPath + '.EngUnit';
        
        // Use the same URL pattern as readTagValue
        const urlsToTry = [
            `/data/simpletagdisplay/readTag?tagPath=${encodeURIComponent(engUnitPath)}`,
            `/main/data/simpletagdisplay/readTag?tagPath=${encodeURIComponent(engUnitPath)}`
        ];
        
        // Try each URL in sequence
        const tryFetch = (urlIndex) => {
            if (urlIndex >= urlsToTry.length) {
                // If all URLs fail, set empty unit
                this.setState({ engUnit: '' });
                return;
            }
            
            const url = urlsToTry[urlIndex];
            
            fetch(url)
                .then(response => {
                    if (!response.ok) {
                        if (response.status === 404 && urlIndex < urlsToTry.length - 1) {
                            // Try next URL
                            return tryFetch(urlIndex + 1);
                        }
                        // If EngUnit doesn't exist, that's okay - just set empty
                        this.setState({ engUnit: '' });
                        return null;
                    }
                    const contentType = response.headers.get("content-type");
                    if (!contentType || !contentType.includes("application/json")) {
                        return tryFetch(urlIndex + 1);
                    }
                    return response.json();
                })
                .then(data => {
                    if (data && data.success && data.isGood && data.value) {
                        // EngUnit exists and has a value
                        const unit = data.value.toString().trim();
                        this.setState({ engUnit: unit });
                    } else {
                        // EngUnit doesn't exist or is empty
                        this.setState({ engUnit: '' });
                    }
                })
                .catch(error => {
                    // If there's an error reading EngUnit, just set empty (it's optional)
                    this.setState({ engUnit: '' });
                });
        };
        
        // Start trying from the first URL
        tryFetch(0);
    }

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
        
        // Apply bounds highlighting to value label if enabled
        if (bounds && bounds.enabled && isConnected && tagValue && !isNaN(tagValue)) {
            const numValue = parseFloat(tagValue);
            const { min, max, minColor, maxColor, minInclusive, maxInclusive } = bounds;
            
            // Check if value is below min
            const isBelowMin = minInclusive ? (numValue < min) : (numValue <= min);
            // Check if value is above max
            const isAboveMax = maxInclusive ? (numValue > max) : (numValue >= max);
            
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

// --- CTG Chart (session trend chart) ---
const CTG_PALETTE = ['#2196F3', '#FF5722', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#F44336', '#8BC34A'];
const CTG_RANGE_PRESETS = [
    { label: '1h',  hours: 1 },
    { label: '4h',  hours: 4 },
    { label: '8h',  hours: 8 },
    { label: '24h', hours: 24 },
    { label: '3d',  hours: 72 },
    { label: '7d',  hours: 168 },
];

let apexChartsLoaded = null;
function loadApexCharts() {
    if (apexChartsLoaded) return apexChartsLoaded;
    apexChartsLoaded = new Promise((resolve, reject) => {
        if (window.ApexCharts) { resolve(window.ApexCharts); return; }
        const script = document.createElement('script');
        script.src = '/res/simpletagdisplay/js/apexcharts.min.js';
        script.onload = () => resolve(window.ApexCharts);
        script.onerror = () => reject(new Error('Failed to load ApexCharts'));
        document.head.appendChild(script);
    });
    return apexChartsLoaded;
}

class CtgChartMeta {
    getComponentType() { return 'com.example.simpletagdisplay.CtgChart'; }
    getViewComponent() { return CtgChart; }
    getDefaultSize() { return { width: 600, height: 400 }; }
    getPropsReducer(tree) {
        const vis = tree.read('visibility', {});
        const interaction = tree.read('interaction', {});
        return {
            mode: tree.readString('mode', 'realtime'),
            rangeHours: tree.readNumber('rangeHours', 24),
            pointCount: tree.readNumber('pointCount', 300),
            refreshRate: tree.readNumber('refreshRate', 5000),
            visibility: {
                showModeToggle:        vis.showModeToggle !== false,
                showRangePresets:      vis.showRangePresets !== false,
                showRefreshRateControl:vis.showRefreshRateControl !== false,
                showRefreshButton:     vis.showRefreshButton !== false,
                showZoomButton:        vis.showZoomButton !== false,
                showLegend:            vis.showLegend !== false,
            },
            interaction: {
                mode: interaction.mode || 'panAndZoom',
                xTraceVisible: interaction.xTraceVisible !== false
            },
        };
    }
}

class CtgChart extends Component {
    constructor(props) {
        super(props);
        this.state = {
            status: 'loading',   // 'loading' | 'ready' | 'empty' | 'error'
            error: null,
            trendListPaths: [],
            lastSeries: [],
            seriesStats: [],
            // Runtime overrides — user sets these via toolbar controls
            runtimeMode: null,
            runtimeRangeHours: null,
            runtimeRefreshRate: null,
            // Interaction mode: 'xtrace' | 'pan' | 'zoom'
            interactionMode: 'xtrace',
        };
        this.chartEl = null;        // DOM element ApexCharts renders into
        this.chartInstance = null;
        this.refreshTimer = null;
        this._zoomedMin = null;     // track whether user has zoomed so silent refresh won't reset it
        this._zoomedMax = null;
        this._yMin = null;          // persistent Y-range — grows but never shrinks until reset
        this._yMax = null;
        this._lastMouseEvent = null; // last mousemove event — used to re-trigger tooltip after refresh
    }

    // --- Effective value getters (runtime overrides take priority over props) ---
    getMode()        { return this.state.runtimeMode || (this.props.props || {}).mode || 'realtime'; }
    getRangeHours()  { const r = this.state.runtimeRangeHours;  return r != null ? r : ((this.props.props || {}).rangeHours  || 24); }
    getRefreshRate() { const r = this.state.runtimeRefreshRate; return r != null ? r : ((this.props.props || {}).refreshRate || 5000); }
    getPointCount()  { return (this.props.props || {}).pointCount || 300; }
    getBaseUrl()     { return window.location.pathname.includes('/main/') ? '/main/data/simpletagdisplay' : '/data/simpletagdisplay'; }

    fetchJson(url) {
        return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    // Compute per-series stats (current, min, max, avg) for the legend table
    computeStats(series) {
        return series.map((s, idx) => {
            const vals = (s.points || []).map(p => p.v).filter(v => v != null && !isNaN(v));
            const current = vals.length ? vals[vals.length - 1] : null;
            const min     = vals.length ? vals.reduce((a, b) => Math.min(a, b), vals[0]) : null;
            const max     = vals.length ? vals.reduce((a, b) => Math.max(a, b), vals[0]) : null;
            const avg     = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            const name    = (s.tagPath || '').split('/').pop() || 'Tag';
            return { tagPath: s.tagPath, name, color: CTG_PALETTE[idx % CTG_PALETTE.length], current, min, max, avg };
        });
    }

    // Fetch trend list then history for current range/pointCount settings
    fetchData() {
        const base = this.getBaseUrl();
        return this.fetchJson(base + '/trendList').then(data => {
            const tagPaths = (data && data.tagPaths) || [];
            if (!tagPaths.length) return { tagPaths: [], series: [] };
            const q = tagPaths.map(x => encodeURIComponent(x)).join(',');
            return this.fetchJson(
                base + '/tagHistory?tagPaths=' + q +
                '&rangeHours=' + this.getRangeHours() +
                '&pointCount=' + this.getPointCount()
            ).then(h => ({ tagPaths, series: (h && h.series) || [] }));
        });
    }

    // Full load — shows loading spinner, recreates chart when done.
    // Always starts the realtime timer on completion so it runs even in empty state.
    initialLoad() {
        this.stopTimer();
        // Reset Y-range, zoom, and trace position so the new time window starts clean
        this._yMin = null;
        this._yMax = null;
        this._zoomedMin = null;
        this._zoomedMax = null;
        this._lastMouseEvent = null;
        this.setState({ status: 'loading', error: null });
        this.fetchData()
            .then(({ tagPaths, series }) => {
                this.setState({
                    status: tagPaths.length === 0 ? 'empty' : 'ready',
                    trendListPaths: tagPaths,
                    lastSeries: series,
                    seriesStats: this.computeStats(series),
                }, () => {
                    // Start timer regardless of empty/ready — silentRefresh handles the
                    // empty→ready transition when the user adds their first tag.
                    this.startTimer();
                    // Legend may have changed row count — sync the chart height after layout.
                    requestAnimationFrame(() => this._syncChartHeight());
                });
            })
            .catch(err => this.setState({ status: 'error', error: (err && err.message) || 'Failed to load' }));
    }

    // Background refresh — no loading state, respects user zoom.
    // Also handles the case where tags are added while the chart is in empty state.
    silentRefresh() {
        if (this.getMode() !== 'realtime') return;
        this.fetchData()
            .then(({ tagPaths, series }) => {
                const wasEmpty = this.state.status === 'empty';
                this.setState({ trendListPaths: tagPaths, lastSeries: series, seriesStats: this.computeStats(series) }, () => {
                    requestAnimationFrame(() => this._syncChartHeight());
                });

                // Tags were added while we were showing the empty state — transition to ready.
                // The chart div will mount and setChartEl will call createChart automatically.
                if (wasEmpty && tagPaths.length > 0) {
                    this.setState({ status: 'ready' });
                    return;
                }

                if (!this.chartInstance) return;

                // Expand persistent Y-range with any new extremes in this tick's data
                this.expandYRange(series);

                // Push series + yaxis + xaxis in one updateOptions call to avoid
                // double-rendering (which caused the alternating scale flicker).
                const xRange = this.computeXRange(series);
                const now = Date.now();
                const rangeMs = this.getRangeHours() * 3600 * 1000;
                const opts = { yaxis: this.getYAxisOptions() };
                if (!this._zoomedMin && !this._zoomedMax) {
                    opts.xaxis = {
                        type: 'datetime',
                        min: xRange.minX != null ? xRange.minX : now - rangeMs,
                        max: xRange.maxX != null ? xRange.maxX : now,
                    };
                }
                // Single updateOptions call (with series embedded) = one redraw per tick instead
                // of two, which eliminates the double-blink on the crosshair/tooltip.
                this.chartInstance.updateOptions(
                    { ...opts, series: this.prepareApexSeries(series) },
                    false,  // redrawPaths — false keeps paths, series key handles data update
                    false   // animate
                ).then(() => {
                    // In X-Trace mode: re-dispatch the last known mousemove so ApexCharts
                    // re-shows the tooltip at the same position with the freshly updated values.
                    this._retriggerXTrace();
                });
            })
            .catch(() => {});  // silent fail — don't disrupt the user
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

    // Build the yaxis options using the persistent range so ApexCharts never
    // snaps back to a narrower scale between refresh ticks.
    getYAxisOptions() {
        if (this._yMin === null || this._yMax === null) {
            return { labels: { formatter: val => val != null ? Number(val).toFixed(2) : '' }, forceNiceScale: true };
        }
        const span    = this._yMax - this._yMin || Math.abs(this._yMax) || 1;
        const padding = span * 0.05;
        return {
            min: this._yMin - padding,
            max: this._yMax + padding,
            labels: { formatter: val => val != null ? Number(val).toFixed(2) : '' },
            forceNiceScale: true,
        };
    }

    prepareApexSeries(series) {
        return (series || []).map(s => ({
            name: (s.tagPath || '').split('/').pop() || 'Tag',
            data: (s.points || []).map(pt => ({ x: pt.t, y: pt.v })),
        }));
    }

    computeXRange(series) {
        let minX = null, maxX = null;
        for (const s of (series || [])) {
            for (const pt of (s.points || [])) {
                if (pt.t == null) continue;
                if (minX === null || pt.t < minX) minX = pt.t;
                if (maxX === null || pt.t > maxX) maxX = pt.t;
            }
        }
        return { minX, maxX };
    }

    buildChartOptions(series) {
        const iMode = this.state.interactionMode;
        const xRange = this.computeXRange(series);
        const now = Date.now();
        const rangeMs = this.getRangeHours() * 3600 * 1000;
        this.expandYRange(series);   // seed persistent range from initial data

        // --- Mode-specific chart config ---
        const chartConfig = this._getChartConfigForMode(iMode);

        return {
            chart: {
                type: 'line',
                height: '100%',
                width: '100%',
                zoom: chartConfig.zoom,
                toolbar: chartConfig.toolbar,
                animations: { enabled: false },
                redrawOnParentResize: true,
                redrawOnWindowResize: true,
                events: {
                    // Mouse tracking is handled by DOM listeners in _setupXTraceListeners —
                    // do NOT duplicate here (causes conflicts with the synthetic re-dispatch).
                    zoomed: (ctx, { xaxis }) => {
                        this._zoomedMin = xaxis.min;
                        this._zoomedMax = xaxis.max;
                        // In zoom mode, recalculate Y-axis for the zoomed range
                        if (this.state.interactionMode === 'zoom') {
                            this._recalcYForRange(xaxis.min, xaxis.max);
                        }
                    },
                    scrolled:        (ctx, { xaxis }) => { this._zoomedMin = xaxis.min; this._zoomedMax = xaxis.max; },
                    beforeResetZoom: ()               => { this._zoomedMin = null; this._zoomedMax = null; },
                },
            },
            colors: CTG_PALETTE,
            series: this.prepareApexSeries(series),
            xaxis: {
                type: 'datetime',
                labels: { show: true },
                tickAmount: 6,
                min: xRange.minX != null ? xRange.minX : now - rangeMs,
                max: xRange.maxX != null ? xRange.maxX : now,
            },
            yaxis: this.getYAxisOptions(),
            stroke: { curve: 'smooth', width: 2 },
            dataLabels: { enabled: false },
            markers: { size: 0 },
            legend: { show: false },   // replaced by custom stats table below
            tooltip: chartConfig.tooltip,
            grid: { borderColor: '#e7e7e7', row: { colors: ['#f3f3f3', 'transparent'], opacity: 0.5 }, padding: { bottom: 20 } },
            crosshairs: chartConfig.crosshairs,
        };
    }

    // Returns mode-specific ApexCharts sub-configs for zoom, tooltip, crosshairs, toolbar
    _getChartConfigForMode(iMode) {
        if (iMode === 'xtrace') {
            return {
                zoom: { enabled: false },
                toolbar: { show: false },
                tooltip: {
                    enabled: true,
                    shared: true,
                    intersect: false,
                    x: { format: 'yyyy/MM/dd HH:mm:ss' },
                    // Tooltip follows cursor horizontally; vertical position is locked
                    // by the CSS !important rule in injectCtgStyles().
                    fixed: { enabled: false },
                },
                crosshairs: {
                    show: true,
                    width: 1,
                    position: 'back',
                    stroke: { color: '#999', width: 1, dashArray: 3 },
                },
            };
        }
        if (iMode === 'pan') {
            return {
                // Pan requires zoom enabled — ApexCharts treats pan as an alt-tool within the zoom feature
                zoom: { enabled: true, type: 'x', autoScaleYaxis: false },
                // Toolbar must exist for pan tool to be selectable; hide it with CSS
                toolbar: { show: true, autoSelected: 'pan' },
                tooltip: { enabled: false },
                crosshairs: { show: false },
            };
        }
        // zoom mode
        return {
            zoom: { enabled: true, type: 'x', autoScaleYaxis: false },
            toolbar: { show: true, autoSelected: 'zoom' },
            tooltip: { enabled: false },
            crosshairs: {
                show: true,
                width: 1,
                position: 'back',
                stroke: { color: '#4CAF50', width: 1, dashArray: 3 },
            },
        };
    }

    // Recalculate Y-axis range for only the data points within the given X range
    _recalcYForRange(xMin, xMax) {
        if (!this.chartInstance) return;
        let yMin = null, yMax = null;
        for (const s of (this.state.lastSeries || [])) {
            for (const pt of (s.points || [])) {
                if (pt.t == null || pt.v == null || isNaN(pt.v)) continue;
                if (pt.t < xMin || pt.t > xMax) continue;
                if (yMin === null || pt.v < yMin) yMin = pt.v;
                if (yMax === null || pt.v > yMax) yMax = pt.v;
            }
        }
        if (yMin !== null && yMax !== null) {
            this._yMin = yMin;
            this._yMax = yMax;
            this.chartInstance.updateOptions({ yaxis: this.getYAxisOptions() }, false, false);
        }
    }

    // Create (or recreate) the ApexCharts instance inside this.chartEl
    createChart(series) {
        const el = this.chartEl;
        if (!el) return;
        this._teardownXTraceListeners();
        loadApexCharts().then(ApexCharts => {
            if (!el || el !== this.chartEl) return;   // stale — element changed before promise resolved
            if (this.chartInstance) { try { this.chartInstance.destroy(); } catch (_) {} this.chartInstance = null; }
            this.chartInstance = new ApexCharts(el, this.buildChartOptions(series));
            return this.chartInstance.render().then(() => {
                this._applyCursorForMode(this.state.interactionMode);
                this._setupXTraceListeners();
                requestAnimationFrame(() => this._syncChartHeight());
            });
        }).catch(() => {
            this.setState({ status: 'error', error: 'Chart library failed to load' });
        });
    }

    // --- X-Trace persistence via native DOM listeners ---
    // ApexCharts only shows the tooltip during mousemove. We need it to persist while
    // the cursor hovers the chart even if the mouse is stationary. We do this by
    // periodically re-dispatching a synthetic mousemove at the last known position.
    _setupXTraceListeners() {
        this._teardownXTraceListeners();
        if (!this.chartEl) return;
        const canvas = this.chartEl.querySelector('.apexcharts-canvas');
        if (!canvas) return;
        this._xtraceCanvas = canvas;

        this._onXTraceMouseMove = (e) => {
            this._lastMouseEvent = e;
        };
        this._onXTraceMouseLeave = () => {
            this._lastMouseEvent = null;
            this._stopXTraceHoldLoop();
        };
        this._onXTraceMouseEnter = () => {
            if (this.state.interactionMode === 'xtrace') {
                this._startXTraceHoldLoop();
            }
        };

        canvas.addEventListener('mousemove', this._onXTraceMouseMove);
        canvas.addEventListener('mouseleave', this._onXTraceMouseLeave);
        canvas.addEventListener('mouseenter', this._onXTraceMouseEnter);
    }

    _teardownXTraceListeners() {
        this._stopXTraceHoldLoop();
        if (this._xtraceCanvas) {
            if (this._onXTraceMouseMove)  this._xtraceCanvas.removeEventListener('mousemove',  this._onXTraceMouseMove);
            if (this._onXTraceMouseLeave) this._xtraceCanvas.removeEventListener('mouseleave', this._onXTraceMouseLeave);
            if (this._onXTraceMouseEnter) this._xtraceCanvas.removeEventListener('mouseenter', this._onXTraceMouseEnter);
            this._xtraceCanvas = null;
        }
    }

    // A small interval that re-fires mousemove so the tooltip stays visible even when the
    // mouse is stationary. Runs only while the cursor is inside the chart in X-Trace mode.
    // Also repositions the tooltip if it clips outside the chart bounds.
    _startXTraceHoldLoop() {
        this._stopXTraceHoldLoop();
        this._xtraceHoldTimer = setInterval(() => {
            if (this.state.interactionMode !== 'xtrace' || !this._lastMouseEvent) {
                this._stopXTraceHoldLoop();
                return;
            }
            this._retriggerXTrace();
        }, 100);  // 10 fps — smooth enough, lightweight
    }

    // Tooltip vertical positioning is handled entirely by CSS (!important rule in injectCtgStyles).
    // No JS override needed — the stylesheet rule beats ApexCharts' inline top.

    _stopXTraceHoldLoop() {
        if (this._xtraceHoldTimer) { clearInterval(this._xtraceHoldTimer); this._xtraceHoldTimer = null; }
    }

    // Ref callback — fires when the chart container div mounts or unmounts
    setChartEl = (el) => {
        if (el) {
            this.chartEl = el;
            if (this.state.status === 'ready') this.createChart(this.state.lastSeries);
        } else {
            this._teardownXTraceListeners();
            this.chartEl = null;
            this.stopTimer();
            if (this.chartInstance) { try { this.chartInstance.destroy(); } catch (_) {} this.chartInstance = null; }
        }
    };

    // Read the chart body div's actual rendered height and push it to ApexCharts so the
    // chart fills the div exactly. Only calls updateOptions when the height changed to avoid
    // unnecessary redraws. Called after setState so the legend has already re-rendered.
    _syncChartHeight() {
        if (!this.chartInstance || !this.chartEl) return;
        const h = this.chartEl.offsetHeight;
        if (h > 0 && h !== this._lastChartHeight) {
            this._lastChartHeight = h;
            this.chartInstance.updateOptions({ chart: { height: h } }, false, false);
        }
    }

    componentDidMount() {
        this.initialLoad();
    }

    componentDidUpdate(prevProps, prevState) {
        // Restart timer when mode or refresh rate changes
        const prevMode = prevState.runtimeMode !== null ? prevState.runtimeMode : ((prevProps.props || {}).mode || 'realtime');
        const prevRate = prevState.runtimeRefreshRate != null ? prevState.runtimeRefreshRate : ((prevProps.props || {}).refreshRate || 5000);
        if ((prevMode !== this.getMode() || prevRate !== this.getRefreshRate()) && this.chartInstance) {
            this.startTimer();
        }
    }

    componentWillUnmount() {
        this.stopTimer();
        this._teardownXTraceListeners();
        if (this.chartInstance) { try { this.chartInstance.destroy(); } catch (_) {} this.chartInstance = null; }
    }

    // --- User action handlers ---
    handleModeChange      = (mode)  => this.setState({ runtimeMode: mode },         () => this.initialLoad());
    handleRangePreset     = (hours) => this.setState({ runtimeRangeHours: hours },   () => this.initialLoad());
    handleRefreshRateChange = (val) => {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && parsed >= 0) this.setState({ runtimeRefreshRate: parsed }, () => { if (this.chartInstance) this.startTimer(); });
    };
    handleManualRefresh   = ()      => this.initialLoad();

    handleRemovePen = (tagPath) => {
        const url = this.getBaseUrl() + '/removeFromTrendList?tagPath=' + encodeURIComponent(tagPath);
        fetch(url, { method: 'GET', credentials: 'same-origin' })
            .finally(() => this.initialLoad());
    };

    resetZoom = () => {
        if (!this.chartInstance) return;
        this._zoomedMin = null;
        this._zoomedMax = null;
        // Recalculate Y-range from current data only (discards old extremes)
        this._yMin = null;
        this._yMax = null;
        this.expandYRange(this.state.lastSeries);
        const xRange = this.computeXRange(this.state.lastSeries);
        const now = Date.now();
        const rangeMs = this.getRangeHours() * 3600 * 1000;
        this.chartInstance.updateOptions({
            xaxis: {
                type: 'datetime',
                min: xRange.minX != null ? xRange.minX : now - rangeMs,
                max: xRange.maxX != null ? xRange.maxX : now,
            },
            yaxis: this.getYAxisOptions(),
        }, false, true);
    };

    // Re-dispatch the last known mousemove at the same screen coordinates so ApexCharts
    // re-shows the tooltip with freshly updated series values without requiring mouse movement.
    _retriggerXTrace() {
        if (this.state.interactionMode !== 'xtrace' || !this._lastMouseEvent || !this.chartEl) return;
        const canvas = this.chartEl.querySelector('.apexcharts-canvas');
        if (!canvas) return;
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            clientX: this._lastMouseEvent.clientX,
            clientY: this._lastMouseEvent.clientY,
            bubbles: true,
            cancelable: true,
        }));
    }

    // Apply the current interaction mode to a live chart instance (called after mode button click).
    // Instead of trying to programmatically click toolbar buttons, we destroy and recreate
    // the chart — ApexCharts' toolbar.autoSelected only takes effect at creation time.
    _applyInteractionMode() {
        if (!this.chartInstance) return;
        // Recreate the chart so autoSelected (pan/zoom) takes effect cleanly
        this.createChart(this.state.lastSeries);
    }

    // Set CSS class on the chart container so cursor rules from the injected stylesheet apply.
    // Using classes (not inline styles) so the :active pseudo-class works for grab→grabbing.
    _applyCursorForMode(iMode) {
        if (!this.chartEl) return;
        this.chartEl.classList.remove('ctg-xtrace-active', 'ctg-pan-active', 'ctg-zoom-active');
        if (iMode === 'xtrace') this.chartEl.classList.add('ctg-xtrace-active');
        if (iMode === 'pan')    this.chartEl.classList.add('ctg-pan-active');
        if (iMode === 'zoom')   this.chartEl.classList.add('ctg-zoom-active');
    }

    handleInteractionModeChange = (iMode) => {
        this._lastMouseEvent = null;  // clear stale position when switching modes
        this._stopXTraceHoldLoop();
        this.setState({ interactionMode: iMode }, () => this._applyInteractionMode());
    };

    // --- Render helpers ---
    renderToolbar() {
        const vis = ((this.props.props || {}).visibility) || {};
        const mode        = this.getMode();
        const rangeHours  = this.getRangeHours();
        const refreshRate = this.getRefreshRate();
        const { status } = this.state;

        const tb  = { flexShrink: 0, padding: '6px 10px', fontSize: '12px', background: '#f0f0f0', borderBottom: '1px solid #ccc', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', userSelect: 'none' };
        const btn = { padding: '3px 8px', fontSize: '12px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: 3, background: '#fff', lineHeight: '1.4' };
        const abn = { ...btn, background: '#2196F3', color: '#fff', borderColor: '#1976D2' };
        const sep = (k) => React.createElement('span', { key: k, style: { display: 'inline-block', width: 1, height: 16, background: '#ccc', margin: '0 4px' } });
        const lbl = (t, k) => React.createElement('span', { key: k, style: { fontSize: '11px', color: '#666' } }, t);

        const iMode = this.state.interactionMode;
        const left = [];

        if (vis.showModeToggle !== false) {
            left.push(lbl('Mode:', 'lm'));
            left.push(React.createElement('button', { key: 'mRT',   style: mode === 'realtime'   ? abn : btn, onClick: () => this.handleModeChange('realtime')   }, 'Realtime'));
            left.push(React.createElement('button', { key: 'mHist', style: mode === 'historical' ? abn : btn, onClick: () => this.handleModeChange('historical') }, 'Historical'));
            left.push(sep('s1'));
        }

        if (vis.showRangePresets !== false) {
            left.push(lbl('Range:', 'lr'));
            CTG_RANGE_PRESETS.forEach(p => {
                const active = Math.abs(rangeHours - p.hours) < 0.001;
                left.push(React.createElement('button', { key: 'rp' + p.label, style: active ? abn : btn, onClick: () => this.handleRangePreset(p.hours) }, p.label));
            });
            left.push(sep('s2'));
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
        left.push(React.createElement('button', { key: 'iAnn',  style: { ...btn, opacity: 0.4, cursor: 'not-allowed' }, disabled: true }, 'Annotate'));

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
            body = React.createElement('div', { key: 'body', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' } }, 'Loading…');
        } else if (status === 'error') {
            body = React.createElement('div', { key: 'body', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c00', padding: 16, textAlign: 'center' } }, error || 'Error');
        } else if (status === 'empty') {
            body = React.createElement('div', { key: 'body', style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', padding: 16, textAlign: 'center' } },
                'No tags in trend list. Right-click a historized tag value → Trend Tag.');
        } else {
            body = React.createElement('div', { key: 'body', ref: this.setChartEl, style: { flex: 1, minHeight: 0, overflow: 'hidden' } });
        }

        return React.createElement('div', { ...emittedProps, style: containerStyle },
            this.renderToolbar(),
            body,
            status === 'ready' ? this.renderLegend() : null,
        );
    }
}

ComponentRegistry.register(new CtgChartMeta());
