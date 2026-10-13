package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import org.junit.jupiter.api.Test;

/** {@link CtgDelegateBase#plainJson}: property-tree values (qualified structures) to plain JSON. */
class PlainJsonTest {

    @Test
    void qualifiedArrayOfMapsBecomesPlainArray() {
        Map<String, Object> pen = new LinkedHashMap<>();
        pen.put("tagPath", new BasicQualifiedValue("[default]CTG/Temp"));
        pen.put("enabled", new BasicQualifiedValue(true));
        pen.put("display", new BasicQualifiedValue(Map.of("width", new BasicQualifiedValue(1.5))));
        QualifiedValue[] pens = {new BasicQualifiedValue(pen)};
        JsonElement j = CtgDelegateBase.plainJson(pens);
        assertTrue(j.isJsonArray());
        assertEquals("[default]CTG/Temp", j.getAsJsonArray().get(0).getAsJsonObject().get("tagPath").getAsString());
        assertTrue(j.getAsJsonArray().get(0).getAsJsonObject().get("enabled").getAsBoolean());
        assertEquals(1.5, j.getAsJsonArray().get(0).getAsJsonObject().getAsJsonObject("display").get("width").getAsDouble());
    }

    @Test
    void scalarsNullsListsAndDates() {
        assertTrue(CtgDelegateBase.plainJson(null).isJsonNull());
        assertTrue(CtgDelegateBase.plainJson(new BasicQualifiedValue(null)).isJsonNull());
        assertEquals("x", CtgDelegateBase.plainJson("x").getAsString());
        assertEquals(3, CtgDelegateBase.plainJson(List.of(1, 2, 3)).getAsJsonArray().size());
        assertEquals(1234L, CtgDelegateBase.plainJson(new Date(1234L)).getAsLong());
    }
}
