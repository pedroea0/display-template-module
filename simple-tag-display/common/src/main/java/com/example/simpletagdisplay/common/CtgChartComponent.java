package com.example.simpletagdisplay.common;

import java.util.List;
import javax.annotation.Nullable;
import javax.swing.Icon;

import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;
import com.inductiveautomation.perspective.common.api.ComponentEventDescriptor;

/**
 * Descriptor of the Click To Graph Chart (palette "Click To Graph Chart").
 *
 * Same pattern as {@link DisplayTemplateComponent}: one factory for both scopes, schema
 * {@code schemas/ctgchart.props.json}, component id unchanged since v1.
 * All four chart events are fired in the browser (user gestures), with flat payloads.
 */
public final class CtgChartComponent {

    /** Component id. MUST match {@code getComponentType()} in ctg-chart.js. UNCHANGED since v1. */
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.CtgChart";

    /** Props schema ({@code schemas/ctgchart.props.json}). */
    public static final JsonSchema SCHEMA = SchemaLoader.schema("/schemas/ctgchart.props.json");

    /** Declared component events. */
    public static final List<ComponentEventDescriptor> EVENTS = List.of(
        SchemaLoader.event("onPensChange",
            "Fired after a user adds, removes or edits a pen at runtime.",
            "/schemas/events/ctgchart.onPensChange.json"),
        SchemaLoader.event("onRangeChange",
            "Fired (debounced) after the user changes the time range, zooms or pans.",
            "/schemas/events/ctgchart.onRangeChange.json"),
        SchemaLoader.event("onBrushChange",
            "Fired when a range brush is added, changed or removed.",
            "/schemas/events/ctgchart.onBrushChange.json"),
        SchemaLoader.event("onXTraceChange",
            "Fired when the pinned X-Trace cursors change.",
            "/schemas/events/ctgchart.onXTraceChange.json")
    );

    /** Descriptor without an icon, registered by the gateway hook. */
    public static final ComponentDescriptor DESCRIPTOR = descriptor(null);

    private CtgChartComponent() {
    }

    /** Builds the descriptor; the Designer passes its palette icon. */
    public static ComponentDescriptor descriptor(@Nullable Icon icon) {
        ComponentDescriptorImpl.ComponentBuilder b = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory(SimpleTagDisplayModule.COMPONENT_CATEGORY)
            .setId(COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(SCHEMA)
            .setEvents(EVENTS)
            .setName("Click To Graph Chart")
            .setDefaultMetaName("CTG-Chart")
            .addPaletteEntry("", "Click To Graph Chart",
                "Trend chart for configured pens and tags added with a Display Template's 'Trend Tag'.", null, null)
            // the tag browser is enabled by default; this variant also opens it on start
            .addPaletteEntry("tagBrowser", "Click To Graph Chart (Tag browser open)",
                "Click To Graph Chart with the in-chart tag browser open when the view starts.", null,
                DisplayTemplateComponent.json("{\"tagBrowser\":{\"enabled\":true,\"openOnStart\":true}}"))
            .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES);
        if (icon != null) {
            b.setIcon(icon);
        }
        return b.build();
    }
}
