/**
 * Simple Tag Display Component for Ignition Perspective
 * A component that displays tag names and values with automatic tag path parsing.
 */

const { Component, ComponentRegistry } = window.PerspectiveClient;

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
            tagNameStyle: tree.read("tagNameStyle", { classes: "" }),
            tagValueStyle: tree.read("tagValueStyle", { classes: "" })
        };
    }
}

/**
 * The Simple Tag Display Component implementation
 */
class SimpleTagDisplay extends Component {
    constructor(props) {
        super(props);
        this.state = {
            tagValue: 'Loading...',
            isConnected: false,
            componentWidth: 0,
            componentHeight: 0
        };
        this.pollInterval = null;
        this.engUnitInterval = null;
        this.componentRef = null;
    }

    componentDidMount() {
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

    componentDidUpdate(prevProps) {
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
        const { tagPath, showTagName, showTagValue, tagNameLabel, valuePrecision, row, evenRow, verticalAlign, showUnits, boolean: booleanConfig, bounds, tagNameStyle, tagValueStyle } = props;
        const { emit } = this.props;
        
        // Use state for tag value (from polling) and EngUnit
        const { tagValue, isConnected, engUnit } = this.state;
        
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
        const baseValueStyle = {
            fontSize: calculateFontSize(tagValueStyleObj, true),
            color: isConnected ? '#000' : '#999',
            fontWeight: 'normal',
            transition: 'font-size 0.2s ease', // Smooth transition when size changes
            textAlign: tagValueStyleObj.textAlign || 'center', // Default to center, use style if set
            width: getWidth()
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
            children.push(React.createElement('div', { 
                style: valueStyle, 
                className: tagValueClasses || undefined,
                key: 'tagValue' 
            }, displayValue));
        }
        
        // Return the component with proper emit() spread to handle flex container properties
        // The emit() function provides: ref, style (with flex properties), className, event handlers, etc.
        // We merge our custom styles while preserving all emit() properties
        return React.createElement('div', 
            {
                ...emittedProps,
                style: containerStyle
            },
            ...children
        );
    }
}

// Register the component
ComponentRegistry.register(new SimpleTagDisplayMeta());
