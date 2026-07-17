package com.example.simpletagdisplay.common;

import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;

/**
 * Java-side descriptor for the SimpleTagDisplay component.
 *
 * Pairs with the JS-side `SimpleTagDisplayMeta` class in simpletagdisplay.js
 * via the shared COMPONENT_ID. The gateway registers DESCRIPTOR at startup
 * (see SimpleTagDisplayGatewayHook#startup), and the designer registers it
 * again at design time (see SimpleTagDisplayDesignerHook).
 *
 * Lives in 'common' scope so it can be referenced by both gateway and designer.
 */
public class SimpleTagDisplayComponent {

    /** MUST match the value returned by SimpleTagDisplayMeta.getComponentType() in the JS. */
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

    /**
     * Property schema parsed from common/src/main/resources/simpletagdisplay.props.json.
     * Defines every binding-eligible prop the designer exposes for this component.
     * A typed JsonSchema (vs. raw JsonObject) lets the designer flag mismatches.
     */
    public static final JsonSchema SCHEMA =
        JsonSchema.parse(SimpleTagDisplayComponent.class.getResourceAsStream("/simpletagdisplay.props.json"));

    /**
     * Descriptor passed to ComponentRegistry.registerComponent(). It tells Perspective:
     *   - where to put it in the component palette (Display category, "Display Template" name)
     *   - which schema and module it belongs to
     *   - which browser JS resources to inject into sessions that use it
     * The palette / project-browser icon is set in the DesignerHook via setIcon() (a Java2D
     * Icon), which only makes sense in the designer scope; the gateway-registered copy has no
     * icon (there is no palette there).
     */
    public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
        .setPaletteCategory("Display")
        .setId(COMPONENT_ID)
        .setModuleId(SimpleTagDisplayModule.MODULE_ID)
        .setSchema(SCHEMA)
        .setName("Display Template")
        .addPaletteEntry("", "Display Template", "Displays a tag's name and value; right-click the value to trend it on a Click To Graph Chart.", null, null)
        .setDefaultMetaName("DisplayTemplate")
        .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
        .build();
}

