package com.example.simpletagdisplay.designer;

import java.util.function.IntFunction;

import javax.swing.Icon;

import com.example.simpletagdisplay.common.CtgChartComponent;
import com.example.simpletagdisplay.common.DisplayTemplateComponent;
import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.designer.model.AbstractDesignerModuleHook;
import com.inductiveautomation.ignition.designer.model.DesignerContext;
import com.inductiveautomation.perspective.designer.DesignerComponentRegistry;
import com.inductiveautomation.perspective.designer.api.PerspectiveDesignerInterface;

/**
 * Designer-scope entry point: registers both components with the Designer's component registry,
 * which feeds the Perspective palette and the project browser.
 *
 * <h2>Icons</h2>
 * The palette and the project-browser tree render {@code ComponentDescriptor.getIcon()}, a {@code javax.swing.Icon}
 * set with {@code ComponentBuilder.setIcon()} (not a URL, and not the first argument of {@code addPaletteEntry}).
 * The descriptors come from the shared factories in the common jar ({@code descriptor(Icon)}: one source of truth
 * for schema, events, palette variants and resources); the Designer only adds the Java2D icons
 * ({@link DisplayTemplateIcon}, {@link CtgChartIcon}), wrapped as multi-resolution images painted at every common
 * display scale ({@link PaletteIcons}) so they stay sharp on HiDPI displays.
 *
 * <h2>Delegates</h2>
 * Nothing here: component model delegates are gateway-side and also run for Designer sessions.
 *
 * <h2>Failure handling</h2>
 * A registration failure is logged once as an ERROR with a clear message instead of escaping into the Designer's
 * module loader: the gateway side keeps working, only the palette entries are missing. Painting the HiDPI icons cannot
 * cause that: a failure there falls back to the plain 16-px painter with a WARN ({@link #icon}). {@code shutdown} removes both
 * components and drops the registry reference. Logger: {@code SimpleTagDisplay.Designer}. There is no
 * {@code getResourceIcon} override: component icons come from the descriptors (see above).
 */
public class SimpleTagDisplayDesignerHook extends AbstractDesignerModuleHook {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Designer");

    /** Icon size of palette entries and project-browser rows. */
    private static final int ICON_SIZE = 16;

    private DesignerComponentRegistry registry;

    @Override
    public void startup(DesignerContext context, LicenseState activationState) {
        try {
            DesignerComponentRegistry r = PerspectiveDesignerInterface.get(context).getDesignerComponentRegistry();
            // Assigned before registering: if the second registration fails, shutdown() still removes the first.
            registry = r;
            r.registerComponent(DisplayTemplateComponent.descriptor(icon(DisplayTemplateIcon::new, "Display Template")));
            r.registerComponent(CtgChartComponent.descriptor(icon(CtgChartIcon::new, "Click To Graph Chart")));
            LOG.debug("Display Template and Click To Graph Chart registered in the Designer palette");
        } catch (Throwable t) {
            LOG.error("Display Template / CTG: could not register the components in the Designer (palette entries are"
                + " missing; views that use them still run on the gateway). Is the Perspective module installed and"
                + " running?", t);
        }
    }

    /**
     * The HiDPI palette icon, or the plain 16-px painter when painting the variants fails: a cosmetic failure must not
     * cost the component its palette entry, so it is a WARN, outside the registration's
     * catch.
     */
    private static Icon icon(IntFunction<Icon> painter, String component) {
        return PaletteIcons.hiDpiOrPlain(painter, ICON_SIZE, t -> LOG.warn("Display Template / CTG: could not paint the"
            + " HiDPI palette icon of " + component + "; using the plain 16 px icon", t));
    }

    @Override
    public void shutdown() {
        DesignerComponentRegistry r = registry;
        registry = null;
        if (r == null) {
            return;
        }
        // Each removal on its own: one that fails (or was never registered) must not keep the other registered.
        for (String id : new String[] {DisplayTemplateComponent.COMPONENT_ID, CtgChartComponent.COMPONENT_ID}) {
            try {
                r.removeComponent(id);
            } catch (Throwable t) {
                LOG.warn("Display Template / CTG: could not remove " + id + " from the Designer palette", t);
            }
        }
    }
}
