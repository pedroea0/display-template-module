package com.example.simpletagdisplay.designer;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;

import javax.swing.Icon;

import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.designer.model.AbstractDesignerModuleHook;
import com.inductiveautomation.ignition.designer.model.DesignerContext;
import com.inductiveautomation.perspective.common.api.ComponentDescriptor;
import com.inductiveautomation.perspective.common.api.ComponentDescriptorImpl;
import com.inductiveautomation.perspective.designer.DesignerComponentRegistry;
import com.inductiveautomation.perspective.designer.api.PerspectiveDesignerInterface;
import com.example.simpletagdisplay.common.SimpleTagDisplayComponent;
import com.example.simpletagdisplay.common.SimpleTagDisplayModule;
import com.example.simpletagdisplay.common.CtgChartComponent;

/**
 * Designer-scope entry point for the Tag Display module.
 *
 * Mirror of SimpleTagDisplayGatewayHook but for the Designer's own component
 * registry — that's what populates the component palette you drag from when
 * editing a Perspective view in the Designer.
 *
 * Component icons:
 *   The Perspective palette (PaletteItem) and the project-browser component tree
 *   render a component's icon from ComponentDescriptor.getIcon() — a
 *   javax.swing.Icon set via ComponentBuilder.setIcon(). The very first attempt
 *   passed a URL into addPaletteEntry()'s variant-id argument (icons are NOT URLs
 *   here) and never called setIcon at all → no icon. A second attempt set an
 *   SVG-rendered Icon via SvgIconUtil, but the designer's SVG-document loader
 *   surfaced an error placeholder. To remove every moving part (resource
 *   resolution, Batik SVG parsing, classloader quirks), the icons are now drawn
 *   directly with Java2D below — no external resources, so they always render.
 *
 * Lifecycle: startup() registers, shutdown() unregisters.
 */
public class SimpleTagDisplayDesignerHook extends AbstractDesignerModuleHook {

    private static final LoggerEx logger = LoggerEx.newBuilder().build("TagDisplay");

    /** Palette + project-browser icons, drawn with Java2D (guaranteed to render). 16px for tree rows. */
    public static final Icon DISPLAY_ICON = new DisplayTemplateIcon(16);
    public static final Icon CHART_ICON   = new CtgChartIcon(16);

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

        // Rebuild each descriptor WITH its Java2D icon via setIcon() — that is what the palette
        // (PaletteItem.getIcon()) and the project-browser tree actually render. The first
        // addPaletteEntry arg is the palette variant id (""), NOT an icon.
        ComponentDescriptor displayDescriptor = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory("Display")
            .setId(SimpleTagDisplayComponent.COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(SimpleTagDisplayComponent.SCHEMA)
            .setName("Display Template")
            .setIcon(DISPLAY_ICON)
            .addPaletteEntry("", "Display Template", "Displays a tag's name and value; right-click the value to trend it on a Click To Graph Chart.", null, null)
            .setDefaultMetaName("DisplayTemplate")
            .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
            .build();
        registry.registerComponent(displayDescriptor);

        ComponentDescriptor ctgDescriptor = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
            .setPaletteCategory("Display")
            .setId(CtgChartComponent.COMPONENT_ID)
            .setModuleId(SimpleTagDisplayModule.MODULE_ID)
            .setSchema(CtgChartComponent.SCHEMA)
            .setName("Click To Graph Chart")
            .setIcon(CHART_ICON)
            .addPaletteEntry("", "Click To Graph Chart", "Session trend chart for tags added via a Display Template's 'Trend Tag'.", null, null)
            .setDefaultMetaName("CTG-Chart")
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
        if (id.getResourceType().equals(SimpleTagDisplayModule.MODULE_ID)) {
            return DISPLAY_ICON;
        }
        return null;
    }

    /* ====================================================================
     *  Java2D icons — drawn from a 24-unit design, scaled to the icon size.
     *  No SVG / Batik / resource loading, so they render in any environment.
     * ==================================================================== */

    /** A value-display "card": a labelled tag showing a name line and a value block. */
    private static final class DisplayTemplateIcon implements Icon {
        private final int size;
        DisplayTemplateIcon(int size) { this.size = size; }
        @Override public int getIconWidth() { return size; }
        @Override public int getIconHeight() { return size; }
        @Override public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                double s = size / 24.0;
                g2.translate(x, y);
                g2.setColor(new Color(0x1E88E5));                                       // blue card
                g2.fill(new RoundRectangle2D.Double(2.5 * s, 4.5 * s, 19 * s, 15 * s, 3 * s, 3 * s));
                g2.setColor(new Color(0xBBDEFB));                                       // light label bar
                g2.fill(new RoundRectangle2D.Double(6 * s, 8 * s, 7 * s, 1.8 * s, 1.4 * s, 1.4 * s));
                g2.setColor(Color.WHITE);                                               // value block
                g2.fill(new RoundRectangle2D.Double(6 * s, 12 * s, 12 * s, 3.6 * s, 1.4 * s, 1.4 * s));
            } finally {
                g2.dispose();
            }
        }
    }

    /** A trend chart: axes plus a line with two highlighted sample points. */
    private static final class CtgChartIcon implements Icon {
        private final int size;
        CtgChartIcon(int size) { this.size = size; }
        @Override public int getIconWidth() { return size; }
        @Override public int getIconHeight() { return size; }
        @Override public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                double s = size / 24.0;
                g2.translate(x, y);
                // Axes (L-shape)
                g2.setColor(new Color(0x607D8B));
                g2.setStroke(new BasicStroke((float) (1.6 * s), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                Path2D axes = new Path2D.Double();
                axes.moveTo(4 * s, 3.5 * s);
                axes.lineTo(4 * s, 19.5 * s);
                axes.lineTo(20.5 * s, 19.5 * s);
                g2.draw(axes);
                // Trend line
                g2.setColor(new Color(0x2196F3));
                g2.setStroke(new BasicStroke((float) (2 * s), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                Path2D line = new Path2D.Double();
                double[][] pts = { {5.5, 16}, {9, 11}, {12.5, 13}, {16, 6.5}, {20, 10} };
                line.moveTo(pts[0][0] * s, pts[0][1] * s);
                for (int i = 1; i < pts.length; i++) line.lineTo(pts[i][0] * s, pts[i][1] * s);
                g2.draw(line);
                // Highlighted points
                g2.setColor(new Color(0xFF5722));
                double r = 1.6 * s;
                double[][] dots = { {9, 11}, {16, 6.5} };
                for (double[] p : dots) {
                    g2.fill(new Ellipse2D.Double(p[0] * s - r, p[1] * s - r, 2 * r, 2 * r));
                }
            } finally {
                g2.dispose();
            }
        }
    }
}
