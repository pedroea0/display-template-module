package com.example.simpletagdisplay.common;

import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;

/**
 * Java-side descriptor for the CtgChart (session trend chart) component.
 *
 * Pairs with the JS-side `CtgChartMeta` class in simpletagdisplay.js via COMPONENT_ID.
 * Schema is loaded from common/src/main/resources/ctgchart.props.json.
 *
 * Note: this component reuses the SAME BROWSER_RESOURCES as SimpleTagDisplay
 * because both components live in the same simpletagdisplay.js bundle.
 * uPlot itself is loaded lazily by that JS — not declared here.
 */
public class CtgChartComponent {

    /** MUST match CtgChartMeta.getComponentType() in the JS. */
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.CtgChart";

    public static final JsonSchema SCHEMA =
        JsonSchema.parse(CtgChartComponent.class.getResourceAsStream("/ctgchart.props.json"));

    public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
        .setPaletteCategory("Display")
        .setId(COMPONENT_ID)
        .setModuleId(SimpleTagDisplayModule.MODULE_ID)
        .setSchema(SCHEMA)
        .setName("Click To Graph Chart")
        .addPaletteEntry("", "Click To Graph Chart", "Session trend chart for tags added via a Display Template's 'Trend Tag'.", null, null)
        .setDefaultMetaName("CTG-Chart")
        .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
        .build();
}
