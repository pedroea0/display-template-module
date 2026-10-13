package com.example.simpletagdisplay.designer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.image.BufferedImage;
import java.awt.image.MultiResolutionImage;
import java.util.List;
import java.util.function.IntFunction;

import javax.swing.Icon;
import javax.swing.ImageIcon;

import org.junit.jupiter.api.Test;

/** Palette icons are multi-resolution images painted at every common display scale (headless). */
class PaletteIconsTest {

    private static int opaque(BufferedImage img) {
        int n = 0;
        for (int y = 0; y < img.getHeight(); y++) {
            for (int x = 0; x < img.getWidth(); x++) {
                n += (img.getRGB(x, y) >>> 24) > 0x80 ? 1 : 0;
            }
        }
        return n;
    }

    private static void check(IntFunction<Icon> painter) {
        ImageIcon icon = PaletteIcons.hiDpi(painter, 16);
        assertEquals(16, icon.getIconWidth(), "logical size unchanged");
        assertEquals(16, icon.getIconHeight());
        assertEquals(java.awt.MediaTracker.COMPLETE, icon.getImageLoadStatus(), "no asynchronous loading");
        assertTrue(icon.getImage() instanceof MultiResolutionImage);
        MultiResolutionImage mri = (MultiResolutionImage) icon.getImage();
        List<Image> variants = mri.getResolutionVariants();
        int[] sizes = variants.stream().mapToInt(i -> i.getWidth(null)).toArray();
        assertEquals("[16, 20, 24, 28, 32, 40, 48]", java.util.Arrays.toString(sizes));

        // Java2D picks the variant matching the device scale: 200 % → the 32 px rendering, not 16 px scaled up.
        assertEquals(32, mri.getResolutionVariant(32, 32).getWidth(null));
        assertEquals(24, mri.getResolutionVariant(24, 24).getWidth(null));

        // Every variant is a real rendering: its painted area grows with the square of the scale (±35 %).
        BufferedImage base = (BufferedImage) variants.get(0);
        BufferedImage x2 = (BufferedImage) mri.getResolutionVariant(32, 32);
        int a1 = opaque(base);
        int a2 = opaque(x2);
        assertTrue(a1 > 20, "base icon is painted: " + a1);
        double ratio = a2 / (double) a1;
        assertTrue(ratio > 4 * 0.65 && ratio < 4 * 1.35, "2x variant painted at 2x: ratio " + ratio);

        // The 2x variant is sharper than the base upscaled: it differs from a nearest-neighbour blow-up of the base.
        BufferedImage up = new BufferedImage(32, 32, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = up.createGraphics();
        g.drawImage(base, 0, 0, 32, 32, null);
        g.dispose();
        int diff = 0;
        for (int y = 0; y < 32; y++) {
            for (int x = 0; x < 32; x++) {
                diff += up.getRGB(x, y) != x2.getRGB(x, y) ? 1 : 0;
            }
        }
        assertTrue(diff > 32, "2x variant is its own rendering, not a resampled 16 px bitmap: " + diff);

        // paintIcon on a 2x device transform draws without error (the palette path).
        BufferedImage target = new BufferedImage(32, 32, BufferedImage.TYPE_INT_ARGB);
        Graphics2D tg = target.createGraphics();
        tg.scale(2, 2);
        icon.paintIcon(null, tg, 0, 0);
        tg.dispose();
        assertTrue(opaque(target) > a1 * 2, "painted at 2x");
    }

    @Test
    void displayTemplateIconIsMultiResolution() {
        check(DisplayTemplateIcon::new);
    }

    @Test
    void chartIconIsMultiResolution() {
        check(CtgChartIcon::new);
    }

    @Test
    void aPaintingFailureFallsBackToThePlainPainter() {
        // A Java2D failure while painting the variants must not cost the palette entry.
        java.util.List<Throwable> seen = new java.util.ArrayList<>();
        Icon plain = new DisplayTemplateIcon(16);
        Icon broken = new Icon() {
            @Override
            public void paintIcon(java.awt.Component c, java.awt.Graphics g, int x, int y) {
                throw new IllegalStateException("exotic graphics environment");
            }

            @Override
            public int getIconWidth() {
                return 16;
            }

            @Override
            public int getIconHeight() {
                return 16;
            }
        };
        Icon got = PaletteIcons.hiDpiOrPlain(px -> px == 16 && !seen.isEmpty() ? plain : broken, 16, seen::add);
        assertEquals(1, seen.size(), "the failure is reported once");
        assertTrue(seen.get(0) instanceof IllegalStateException);
        assertTrue(got == plain, "the plain 16 px painter is used");
        assertTrue(PaletteIcons.hiDpiOrPlain(DisplayTemplateIcon::new, 16, seen::add) instanceof ImageIcon,
            "no failure: the HiDPI icon");
        assertEquals(1, seen.size());
        assertThrows(OutOfMemoryError.class, () -> PaletteIcons.hiDpiOrPlain(px -> {
            throw new OutOfMemoryError("test");
        }, 16, seen::add), "a VirtualMachineError is not swallowed");
    }
}
