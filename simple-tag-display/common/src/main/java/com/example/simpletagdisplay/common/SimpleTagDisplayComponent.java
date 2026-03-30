package com.example.simpletagdisplay.common;

import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;

/**
 * Describes the Tag Display component to the Java registry so the gateway and designer know to look for the front end elements.
 * In a 'common' scope so that it's referenceable by both gateway and designer.
 */
public class SimpleTagDisplayComponent {

    // Unique ID of the component which perfectly matches that provided in the javascript's ComponentMeta implementation
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

    /**
     * The schema provided with the component descriptor. Use a schema instead of a plain JsonObject because it gives
     * us a little more type information, allowing the designer to highlight mismatches where it can detect them.
     */
    public static final JsonSchema SCHEMA =
        JsonSchema.parse(SimpleTagDisplayComponent.class.getResourceAsStream("/simpletagdisplay.props.json"));

    /**
     * Components register with the Java side ComponentRegistry by providing a ComponentDescriptor. Here we
     * build the descriptor for this component.
     * Note: The icon will be set in the DesignerHook where we can convert Icon to BufferedImage.
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

