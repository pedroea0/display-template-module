package com.example.simpletagdisplay.designer;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.geom.Path2D;

import javax.swing.Icon;

/**
 * Palette / project-browser icon of the Click To Graph Chart: axes plus a trend line with two highlighted samples.
 *
 * Drawn with Java2D from a 24-unit design scaled to {@code size} (see {@link DisplayTemplateIcon} for why no SVG).
 */
public final class CtgChartIcon implements Icon {

    private final int size;

    public CtgChartIcon(int size) {
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
            double[][] pts = {{5.5, 16}, {9, 11}, {12.5, 13}, {16, 6.5}, {20, 10}};
            line.moveTo(pts[0][0] * s, pts[0][1] * s);
            for (int i = 1; i < pts.length; i++) {
                line.lineTo(pts[i][0] * s, pts[i][1] * s);
            }
            g2.draw(line);
            // Highlighted points
            g2.setColor(new Color(0xFF5722));
            double r = 1.6 * s;
            double[][] dots = {{9, 11}, {16, 6.5}};
            for (double[] p : dots) {
                g2.fill(new Ellipse2D.Double(p[0] * s - r, p[1] * s - r, 2 * r, 2 * r));
            }
        } finally {
            g2.dispose();
        }
    }
}
