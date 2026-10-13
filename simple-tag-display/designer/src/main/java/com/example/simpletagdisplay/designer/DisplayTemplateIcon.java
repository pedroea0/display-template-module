package com.example.simpletagdisplay.designer;

import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.RoundRectangle2D;

import javax.swing.Icon;

/**
 * Palette / project-browser icon of the Display Template: a blue value "card" with a name line and a value block.
 *
 * Drawn with Java2D from a 24-unit design scaled to {@code size}: no SVG, no resource loading, so it renders in
 * every Designer (an earlier SVG icon showed the Designer's error placeholder).
 */
public final class DisplayTemplateIcon implements Icon {

    private final int size;

    public DisplayTemplateIcon(int size) {
        this.size = size;
    }

    @Override
    public int getIconWidth() {
        return size;
    }

    @Override
    public int getIconHeight() {
        return size;
    }

    @Override
    public void paintIcon(Component c, Graphics g, int x, int y) {
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
