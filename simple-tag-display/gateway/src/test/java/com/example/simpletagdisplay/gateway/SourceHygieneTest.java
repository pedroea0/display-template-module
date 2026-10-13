package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;

/**
 * A javadoc must start on its own line. The defect was once found in ChartOps ({@code ... duplicate() {    /**}),
 * and the change that fixed it there added the same defect in DisplayTemplateDelegate
 * ({@code private final Host host = new Host();    /**}). Scanning every gateway source keeps the defect class from
 * coming back anywhere.
 */
class SourceHygieneTest {

    /** Code (anything but whitespace) followed by the start of a javadoc on the same line. */
    private static final Pattern CODE_THEN_JAVADOC = Pattern.compile("^\\s*[^\\s/*].*\\S\\s*/\\*\\*(?!.*\\*/).*$");

    @Test
    void noJavadocStartsOnACodeLine() throws IOException {
        List<String> bad = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path f : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".java"))::iterator) {
                List<String> lines = Files.readAllLines(f, StandardCharsets.UTF_8);
                for (int i = 0; i < lines.size(); i++) {
                    String line = lines.get(i);
                    if (CODE_THEN_JAVADOC.matcher(line).matches() && !line.contains("\"")) {
                        bad.add(f.getFileName() + ":" + (i + 1) + ": " + line.trim());
                    }
                }
            }
        }
        assertEquals(List.of(), bad, "javadoc on the same line as code");
    }
}
