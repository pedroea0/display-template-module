package com.example.simpletagdisplay.designer;

import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.image.BaseMultiResolutionImage;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.IntFunction;

import javax.swing.Icon;
import javax.swing.ImageIcon;

/**
 * HiDPI palette icons: turns one of the Java2D icon painters ({@link DisplayTemplateIcon},
 * {@link CtgChartIcon}) into an {@link ImageIcon} over a {@link BaseMultiResolutionImage} whose variants are painted
 * at every common display scale.
 *
 * <h2>Why</h2>
 * A descriptor that carries a plain painter sized 16 px is not enough. Where the palette or the project
 * browser paints the icon straight into a scaled {@code Graphics2D} that is already sharp, but Swing code that works
 * with the icon's <em>image</em> — the look and feel's disabled icon ({@code getDisabledIcon} only handles
 * {@code ImageIcon}), trees and lists that cache a rendering, drag images — renders it at 16 device pixels and
 * scales the bitmap up, so on a 150 % or 200 % Windows display the palette icons were blurry. A multi-resolution image
 * lets Java2D pick the variant matching the device transform (JDK 9+), so every path gets real pixels:
 * <pre>
 *   logical size 16 px → variants 16, 20, 24, 28, 32, 40, 48 px  (100 %, 125 %, 150 %, 175 %, 200 %, 250 %, 300 %)
 * </pre>
 * The first variant is the base image: {@code getIconWidth()} stays 16, so layouts do not change. Each variant is a
 * fresh vector rendering of the 24-unit design at that pixel size (not a resampled bitmap), with antialiasing and
 * pure-stroke geometry.
 */
final class PaletteIcons {

    /** Display scales a variant is painted for (the first one is the base image). */
    static final double[] SCALES = {1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0};

    private PaletteIcons() {
    }

    /**
     * A {@code size}-px icon with one painted variant per {@link #SCALES} entry.
     *
     * @param painter creates the vector painter for a given pixel size ({@code DisplayTemplateIcon::new})
     */
    static ImageIcon hiDpi(IntFunction<Icon> painter, int size) {
        List<Image> variants = new ArrayList<>();
        int last = -1;
        for (double scale : SCALES) {
            int px = (int) Math.round(size * scale);
            if (px == last) {
                continue;                               // tiny sizes: two scales can round to one pixel size
            }
            last = px;
            variants.add(paint(painter.apply(px), px));
        }
        return new ImageIcon(new BaseMultiResolutionImage(variants.toArray(new Image[0])));
    }

    /**
     * {@link #hiDpi}, or the plain {@code size}-px painter when painting the variants fails (an exotic graphics
     * environment, a headless toolkit quirk): the icon is only cosmetic, so a failure here must never cost the
     * component its palette entry. {@code onFailure} is told why (the hook logs it).
     * A {@link VirtualMachineError} (out of memory and the like) is not swallowed.
     */
    static Icon hiDpiOrPlain(IntFunction<Icon> painter, int size, Consumer<Throwable> onFailure) {
        try {
            return hiDpi(painter, size);
        } catch (VirtualMachineError e) {
            throw e;
        } catch (Throwable t) {
            onFailure.accept(t);
            return painter.apply(size);
        }
    }

    /** One variant: the painter at {@code px} × {@code px} on a transparent ARGB image. */
    static BufferedImage paint(Icon icon, int px) {
        BufferedImage img = new BufferedImage(px, px, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            icon.paintIcon(null, g, 0, 0);
        } finally {
            g.dispose();
        }
        return img;
    }
}
