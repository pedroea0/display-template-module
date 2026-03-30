package com.example.simpletagdisplay.common;

import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;

/**
 * Describes the CTG Chart component (session trend chart) for the Java registry.
 */
public class CtgChartComponent {

    public static final String COMPONENT_ID = "com.example.simpletagdisplay.CtgChart";

    public static final JsonSchema SCHEMA =
        JsonSchema.parse(CtgChartComponent.class.getResourceAsStream("/ctgchart.props.json"));

    public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
        .setPaletteCategory("Display")
        .setId(COMPONENT_ID)
        .setModuleId(SimpleTagDisplayModule.MODULE_ID)
        .setSchema(SCHEMA)
        .setName("CTG Chart")
        .addPaletteEntry("", "CTG Chart", "Session trend chart for tags added via Tag Display 'Trend Tag'.", null, null)
        .setDefaultMetaName("ctgChart")
        .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
        .build();
}
