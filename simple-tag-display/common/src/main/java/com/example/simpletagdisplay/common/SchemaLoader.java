package com.example.simpletagdisplay.common;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.jsonschema.JsonSchema;
import com.inductiveautomation.perspective.common.api.ComponentEventDescriptor;

/**
 * Loads the JSON schemas bundled in the common jar (props schemas and component event schemas).
 *
 * v1 called {@code JsonSchema.parse(getResourceAsStream(...))} inline in a static initializer: a missing or
 * renamed resource became a {@code NullPointerException} deep inside the parser, the stream was never closed
 * and the component simply did not register. Here every load uses try-with-resources and a missing
 * resource fails with a message that names it.
 */
public final class SchemaLoader {

    private SchemaLoader() {
    }

    /**
     * Parses a schema resource from the common jar.
     *
     * @param resource absolute classpath resource, e.g. {@code /schemas/displaytemplate.props.json}
     * @throws IllegalStateException when the resource is missing or cannot be parsed
     */
    public static JsonSchema schema(String resource) {
        try (InputStream in = SchemaLoader.class.getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + resource);
            }
            return JsonSchema.parse(in);
        } catch (IOException e) {
            throw new IllegalStateException("cannot read schema " + resource, e);
        } catch (RuntimeException e) {
            throw new IllegalStateException("invalid schema " + resource + ": " + e, e);
        }
    }

    /**
     * Reads a bundled JSON resource as a plain object (used where the raw schema text is needed, e.g. to build a
     * debug event payload from an event schema's property list).
     *
     * @throws IllegalStateException when the resource is missing or is not a JSON object
     */
    public static JsonObject json(String resource) {
        try (InputStream in = SchemaLoader.class.getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + resource);
            }
            return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException e) {
            throw new IllegalStateException("cannot read " + resource, e);
        } catch (RuntimeException e) {
            throw new IllegalStateException("invalid JSON in " + resource + ": " + e, e);
        }
    }

    /**
     * Builds a component event descriptor whose payload schema is loaded from {@code resource}. The schema's
     * property descriptions are what the Designer shows for {@code event.<name>} in event scripts.
     */
    public static ComponentEventDescriptor event(String name, String description, String resource) {
        return new ComponentEventDescriptor(name, description, schema(resource));
    }
}
