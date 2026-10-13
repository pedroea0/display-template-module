package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import java.util.List;
import java.util.Set;
import java.util.function.Function;

import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import org.junit.jupiter.api.Test;

/**
 * Read-scope bypass guard: the Designer-pen shadow adopts only the delta a non-Browser change wrote at its own path,
 * never the browser-written entries around it.
 */
class DesignPensTest {

    private static final Function<String, String> KEY = raw -> {
        TagPaths.Parsed p = TagPaths.parse(raw, "default");
        return p.ok() ? TagPaths.normalizedKey(p.path()) : null;
    };

    private static JsonElement json(String s) {
        return JsonParser.parseString(s);
    }

    /** The live array after a viewer appended runtime pens to the Designer's [Temp]. */
    private static final String LIVE = "[{\"tagPath\":\"[default]CTG/Temp\",\"name\":\"T\"},"
        + "{\"tagPath\":\"[System]Gateway/SystemName\"},{\"tagPath\":\"[default]_CTG_research/X\"},"
        + "{\"tagPath\":\"[CTG_Edit]Anything\"}]";

    private static DesignPens start() {
        return DesignPens.of(json("[{\"tagPath\":\"[default]CTG/Temp\",\"name\":\"T\"}]"), KEY);
    }

    @Test
    void startValueIsTheDesignerConfiguration() {
        DesignPens d = start();
        assertEquals(Set.of("[default]ctg/temp"), d.keys());
        assertEquals(1, d.size());
        assertEquals(Set.of(), DesignPens.of(JsonNull.INSTANCE, KEY).keys());
        assertEquals(Set.of(), DesignPens.of(json("{\"tagPath\":\"[default]CTG/Temp\"}"), KEY).keys(), "not an array");
        DesignPens mixed = DesignPens.of(json("[5, {\"tagPath\":\"CTG/Running\"}, {\"tagPath\":\"CTG/../Secret\"},"
            + " {\"tagPath\":7}, {\"tagPath\":\"[default]CTG/Temp\",\"enabled\":false}]"), KEY);
        assertEquals(Set.of("[default]ctg/running", "[default]ctg/temp"), mixed.keys(),
            "default provider, invalid paths skipped, disabled entries still Designer-configured");
    }

    /** The reproduced bypass: a binding on pens[0].name ticks while the live array holds browser-written pens. */
    @Test
    void bindingOnANameAdoptsNothing() {
        DesignPens d = start();
        for (String path : List.of("pens[0].name", "props.pens[0].name", "pens[0].color", "pens[0].enabled",
                "pens[2].style.color", "pens[0].axis")) {
            assertSame(d, d.apply(path, new JsonPrimitive("T42"), KEY), path);
        }
        // whatever value the event carries, a sub-path that is not the tag chooses no tag
        assertSame(d, d.apply("pens[1].name", json(LIVE), KEY));
        assertEquals(Set.of("[default]ctg/temp"), d.keys());
    }

    @Test
    void tagPathOfOneEntryAdoptsOnlyThatEntry() {
        DesignPens d = start().apply("pens[1].tagPath", new JsonPrimitive("[CTG_Edit]A"), KEY);
        assertEquals(Set.of("[default]ctg/temp", "[ctg_edit]a"), d.keys());
        // a binding cycling through tags replaces its own entry, it does not accumulate
        d = d.apply("pens[1].tagPath", new JsonPrimitive("[CTG_Edit]B"), KEY);
        assertEquals(Set.of("[default]ctg/temp", "[ctg_edit]b"), d.keys());
        // dotted index form
        d = d.apply("pens.1.tagPath", new JsonPrimitive("[CTG_Edit]C"), KEY);
        assertEquals(Set.of("[default]ctg/temp", "[ctg_edit]c"), d.keys());
        // an invalid / non-string value clears the entry
        assertEquals(Set.of("[default]ctg/temp"), d.apply("pens[1].tagPath", new JsonPrimitive("a/../b"), KEY).keys());
        assertEquals(Set.of("[default]ctg/temp"), d.apply("pens[1].tagPath", JsonNull.INSTANCE, KEY).keys());
        assertEquals(Set.of("[default]ctg/temp"), d.apply("pens[1].tagPath", new JsonPrimitive(5), KEY).keys());
        // the Designer's own pen can be re-pointed too (index 0)
        assertEquals(Set.of("[default]ctg/running", "[ctg_edit]c"),
            d.apply("pens[0].tagPath", new JsonPrimitive("CTG/Running"), KEY).keys());
        // index far past the end: padded
        DesignPens far = start().apply("pens[9].tagPath", new JsonPrimitive("CTG/Running"), KEY);
        assertEquals(10, far.size());
        assertEquals(Set.of("[default]ctg/temp", "[default]ctg/running"), far.keys());
    }

    @Test
    void entryReplacementAdoptsThatEntry() {
        JsonObject entry = new JsonObject();
        entry.addProperty("tagPath", "[CTG_Edit]Anything");
        DesignPens d = start().apply("pens[3]", entry, KEY);
        assertEquals(Set.of("[default]ctg/temp", "[ctg_edit]anything"), d.keys());
        assertEquals(Set.of(), start().apply("pens[0]", JsonNull.INSTANCE, KEY).keys(), "entry removed / nulled");
    }

    @Test
    void rootReplacementAdoptsTheNewArray() {
        DesignPens d = start().apply("pens", json(LIVE), KEY);
        assertEquals(Set.of("[default]ctg/temp", "[system]gateway/systemname", "[default]_ctg_research/x",
            "[ctg_edit]anything"), d.keys(), "a Binding/Script that writes the whole array configures every entry");
        assertEquals(Set.of(), start().apply("props.pens", new JsonArray(), KEY).keys());
    }

    @Test
    void unknownOrForeignPathsAdoptNothing() {
        DesignPens d = start();
        for (String path : new String[] {null, "", "pensX[0].tagPath", "trendGroup", "pens[", "pens[a].tagPath",
                "pens[-1].tagPath", "pens[99999999999].tagPath", "pens..tagPath", "pens.name", "pens[4096].tagPath"}) {
            assertSame(d, d.apply(path, new JsonPrimitive("[CTG_Edit]X"), KEY), String.valueOf(path));
        }
    }

    @Test
    void pathParsing() {
        assertEquals(List.of(), DesignPens.parsePath("pens"));
        assertEquals(List.of(), DesignPens.parsePath("props.pens"));
        assertEquals(List.of(2), DesignPens.parsePath("pens[2]"));
        assertEquals(List.of(2, "tagPath"), DesignPens.parsePath("pens[2].tagPath"));
        assertEquals(List.of(2, "tagPath"), DesignPens.parsePath("pens.2.tagPath"));
        assertEquals(List.of(0, "style", "color"), DesignPens.parsePath("pens[0].style.color"));
        assertNull(DesignPens.parsePath("pensive"));
        assertNull(DesignPens.parsePath(null));
    }

    @Test
    void bounded() {
        JsonArray big = new JsonArray();
        for (int i = 0; i < DesignPens.MAX_ENTRIES + 100; i++) {
            JsonObject o = new JsonObject();
            o.addProperty("tagPath", "CTG/T" + i);
            big.add(o);
        }
        DesignPens d = DesignPens.of(big, KEY);
        assertEquals(DesignPens.MAX_ENTRIES, d.size());
        assertEquals(DesignPens.MAX_ENTRIES, d.keys().size());
    }
}
