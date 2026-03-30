package com.example.simpletagdisplay.designer;

import javax.swing.Icon;

import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;

import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.designer.model.AbstractDesignerModuleHook;
import com.inductiveautomation.ignition.designer.model.DesignerContext;
import com.inductiveautomation.ignition.designer.navtree.icon.InteractiveSvgIcon;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;
import com.inductiveautomation.perspective.designer.DesignerComponentRegistry;
import com.inductiveautomation.perspective.designer.api.PerspectiveDesignerInterface;
import com.example.simpletagdisplay.common.SimpleTagDisplayComponent;
import com.example.simpletagdisplay.common.SimpleTagDisplayModule;
import com.example.simpletagdisplay.common.CtgChartComponent;

/**
 * Designer-scope module hook for Tag Display module.
 * This module provides a component for displaying tag names and values.
 */
public class SimpleTagDisplayDesignerHook extends AbstractDesignerModuleHook {
    
    private static final LoggerEx logger = LoggerEx.newBuilder().build("TagDisplay");
    
    /**
     * Component icon for project browser and palette.
     * Created from the SVG icon resource file in the common module.
     */
    public static final Icon COMPONENT_ICON = createComponentIcon();
    
    private static Icon createComponentIcon() {
        // Load icon from common module resources
        try {
            return InteractiveSvgIcon.createIconAll(
                SimpleTagDisplayComponent.class, "/icon.svg", 16, 16, true
            );
        } catch (Exception e) {
            logger.error("Failed to load component icon", e);
            return null;
        }
    }
    
    private DesignerContext context;
    private DesignerComponentRegistry registry;

    public SimpleTagDisplayDesignerHook() {
        logger.info("Registering Tag Display component in Designer!");
    }

    @Override
    public void startup(DesignerContext context, LicenseState activationState) throws Exception {
        this.context = context;
        init();
    }

    private void init() {
        logger.debug("Initializing Tag Display component registration...");

        PerspectiveDesignerInterface pdi = PerspectiveDesignerInterface.get(context);
        registry = pdi.getDesignerComponentRegistry();

        // Use the mounted icon resource URL for the palette entry
        // The icon is mounted at /res/simpletagdisplay/icon.svg
        String iconUrl = String.format("/res/%s/icon.svg", SimpleTagDisplayModule.URL_ALIAS);
        logger.debug("Using icon URL for palette: " + iconUrl);
        
        // Rebuild descriptor with icon URL for palette entry
        ComponentDescriptor descriptorWithIcons = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory("Display")
            .setId(SimpleTagDisplayComponent.COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(SimpleTagDisplayComponent.SCHEMA)
            .setName("Tag Display")
            .addPaletteEntry(iconUrl, "Tag Display", "Displays tag names and values with automatic tag path parsing.", null, null)
            .setDefaultMetaName("simpleTagDisplay")
            .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
            .build();

        // Register components to get them on the palette
        registry.registerComponent(descriptorWithIcons);

        ComponentDescriptor ctgDescriptor = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory("Display")
            .setId(CtgChartComponent.COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(CtgChartComponent.SCHEMA)
            .setName("CTG Chart")
            .addPaletteEntry(iconUrl, "CTG Chart", "Session trend chart for tags added via Tag Display 'Trend Tag'.", null, null)
            .setDefaultMetaName("ctgChart")
            .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
            .build();
        registry.registerComponent(ctgDescriptor);
    }

    @Override
    public void shutdown() {
        removeComponents();
    }

    private void removeComponents() {
        if (registry != null) {
            registry.removeComponent(SimpleTagDisplayComponent.COMPONENT_ID);
            registry.removeComponent(CtgChartComponent.COMPONENT_ID);
        }
    }

    @Override
    public Icon getResourceIcon(ResourcePath id) {
        // Return the icon for our component in the project browser
        if (id.getResourceType().equals(SimpleTagDisplayModule.MODULE_ID)) {
            return COMPONENT_ICON;
        }
        return null;
    }
}
