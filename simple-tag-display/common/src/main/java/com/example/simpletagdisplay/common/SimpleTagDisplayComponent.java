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
     *   - where to put it in the component palette (Display category, "Tag Display" name)
     *   - which schema and module it belongs to
     *   - which browser JS resources to inject into sessions that use it
     * Icon (palette thumbnail) is set later in the DesignerHook because Icon → BufferedImage
     * conversion only makes sense in the designer scope.
     */
    public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
        .setPaletteCategory("Display")
        .setId(COMPONENT_ID)
        .setModuleId(SimpleTagDisplayModule.MODULE_ID)
        .setSchema(SCHEMA)
        .setName("Tag Display")
        .addPaletteEntry("", "Tag Display", "Displays tag names and values with automatic tag path parsing.", null, null)
        .setDefaultMetaName("simpleTagDisplay")
        .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
        .build();
}

