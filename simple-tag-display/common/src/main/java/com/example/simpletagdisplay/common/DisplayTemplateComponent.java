package com.example.simpletagdisplay.common;

import java.util.List;
import javax.annotation.Nullable;
import javax.swing.Icon;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;
import com.inductiveautomation.perspective.common.api.ComponentEventDescriptor;

/**
 * Descriptor of the Display Template component (palette "Display Template").
 *
 * The component id is the v1 id ({@code ...SimpleTagDisplay}) so existing views keep resolving after the upgrade;
 * the props are a clean break (v2 schema, {@code schemas/displaytemplate.props.json}; v1 views are converted with
 * {@code tools/migrate-v1-views.mjs}).
 *
 * One factory builds the descriptor for both scopes, so the gateway and Designer descriptors cannot drift apart:
 * the gateway registers {@link #DESCRIPTOR} (no icon), the Designer hook registers
 * {@code descriptor(icon)} with its Java2D palette icon.
 *
 * Events (all payloads flat, schemas under {@code schemas/events/}):
 * <ul>
 *   <li>{@code onSetpointWrite}, {@code onTagConfigEdit}, {@code onTrendChange} — fired on the gateway by the
 *       delegate after the operation (before the reply).</li>
 *   <li>{@code onMenuAction} — fired in the browser for pure-UI menu items.</li>
 * </ul>
 */
public final class DisplayTemplateComponent {

    /** Component id. MUST match {@code getComponentType()} in display-template.js. UNCHANGED since v1. */
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

    /** Props schema ({@code schemas/displaytemplate.props.json}). */
    public static final JsonSchema SCHEMA = SchemaLoader.schema("/schemas/displaytemplate.props.json");

    /** Declared component events, in the order the Designer lists them. */
    public static final List<ComponentEventDescriptor> EVENTS = List.of(
        SchemaLoader.event("onSetpointWrite",
            "Fired on the gateway after every setpoint write attempt that reached the tag (success or failure).",
            "/schemas/events/displaytemplate.onSetpointWrite.json"),
        SchemaLoader.event("onTagConfigEdit",
            "Fired on the gateway after an attempt to change the tag's units or engineering limits.",
            "/schemas/events/displaytemplate.onTagConfigEdit.json"),
        SchemaLoader.event("onTrendChange",
            "Fired on the gateway after the tag was added to or removed from the session trend list.",
            "/schemas/events/displaytemplate.onTrendChange.json"),
        SchemaLoader.event("onMenuAction",
            "Fired in the browser when a menu item (custom item, trend page or trend popup) is chosen.",
            "/schemas/events/displaytemplate.onMenuAction.json")
    );

    /** Descriptor without an icon, registered by the gateway hook. */
    public static final ComponentDescriptor DESCRIPTOR = descriptor(null);

    private DisplayTemplateComponent() {
    }

    /**
     * Builds the descriptor. The Designer passes its palette icon; Perspective renders
     * {@code ComponentDescriptor.getIcon()} in the palette and the project browser.
     */
    public static ComponentDescriptor descriptor(@Nullable Icon icon) {
        ComponentDescriptorImpl.ComponentBuilder b = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory(SimpleTagDisplayModule.COMPONENT_CATEGORY)
            .setId(COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(SCHEMA)
            .setEvents(EVENTS)
            .setName("Display Template")
            .setDefaultMetaName("DisplayTemplate")
            .addPaletteEntry("", "Display Template",
                "Tag name and live value, setpoint entry, alarm colours, right-click Trend Tag.", null, null)
            .addPaletteEntry("setpoint", "Display Template (Setpoint)",
                "Display Template with setpoint entry enabled.", null, json("{\"setpoint\":{\"enabled\":true}}"))
            .addPaletteEntry("row", "Display Template (Row)",
                "Display Template with the label beside the value.", null, json("{\"layout\":{\"direction\":\"row\"}}"))
            .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES);
        if (icon != null) {
            b.setIcon(icon);
        }
        return b.build();
    }

    static JsonObject json(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }
}
