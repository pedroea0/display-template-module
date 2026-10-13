import java.nio.ByteBuffer
import java.security.MessageDigest

plugins {
    `java-library`
}

java {
    toolchain {
        languageVersion.set(org.gradle.jvm.toolchain.JavaLanguageVersion.of(17))
    }
}


dependencies {
    compileOnly("com.inductiveautomation.ignitionsdk:ignition-common:${rootProject.extra["sdk_version"]}")
    compileOnly("com.inductiveautomation.ignitionsdk:gateway-api:${rootProject.extra["sdk_version"]}")
    compileOnly("com.inductiveautomation.ignitionsdk:perspective-common:${rootProject.extra["sdk_version"]}")
    compileOnly("com.inductiveautomation.ignitionsdk:perspective-gateway:${rootProject.extra["sdk_version"]}")
    compileOnly(project(":common"))

    // ---- unit tests (JUnit 5) ----------------------------------------------
    // The SDK artifacts are compileOnly for the module (the gateway provides
    // them at runtime), so the tests need them on their own classpath.
    testImplementation("com.inductiveautomation.ignitionsdk:ignition-common:${rootProject.extra["sdk_version"]}")
    testImplementation("com.inductiveautomation.ignitionsdk:gateway-api:${rootProject.extra["sdk_version"]}")
    testImplementation("com.inductiveautomation.ignitionsdk:perspective-common:${rootProject.extra["sdk_version"]}")
    testImplementation("com.inductiveautomation.ignitionsdk:perspective-gateway:${rootProject.extra["sdk_version"]}")
    testImplementation(project(":common"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.2")
}

tasks.named<Test>("test") {
    useJUnitPlatform()
    // Test vectors shared with the Node tests (tests/vectors); declared as an input so a vector change re-runs the tests.
    val vectorsDir = rootProject.file("tests/vectors")
    inputs.dir(vectorsDir)
    systemProperty("ctg.test.vectors", vectorsDir.absolutePath)
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

// ---------------------------------------------------------------------------
// Build id
// ---------------------------------------------------------------------------
// mounted/build-id.txt = 64 hex chars (SHA-256) identifying EVERYTHING the three
// jars carry, not just the web resources. The gateway serves it at
// /res/simpletagdisplay/build-id.txt and logs it at startup, so
// deploy_ignition_module.py (step 17 and --verify-running) can prove the gateway
// runs exactly this build's Java classes, schemas and resources. Comparing only
// the mounted JS/CSS would give a false PASS for Java-only changes.
//
// The algorithm is defined on JAR ENTRIES, so the deploy script recomputes it
// from the .modl and refuses a .modl whose classes were changed after the build
// (exit 3). For jar in common, designer, gateway (this order); entries sorted by
// name (ordinal); every file entry except META-INF/MANIFEST.MF and, in the
// gateway jar, mounted/build-id.txt itself:
//     update(UTF-8 "<jar>/<entry name>") ; update(0x00) ;
//     update(8-byte big-endian length) ; update(entry bytes)
// Here the entries are read from the directories the jar tasks package: each
// project's compiled classes + processed resources, except that the gateway's
// resources are read from src/main/resources (its processed resources would
// contain this very file). deploy_ignition_module.py and build-and-sign.ps1
// implement the same algorithm; a mismatch between the two sides is a build
// error (exit 3), so they cannot drift silently.
// ---------------------------------------------------------------------------
val buildIdDir = layout.buildDirectory.dir("generated/build-id")
val buildIdRoots: List<Pair<String, List<File>>> = listOf(
    "common" to listOf(rootProject.file("common/build/classes/java/main"), rootProject.file("common/build/resources/main")),
    "designer" to listOf(rootProject.file("designer/build/classes/java/main"), rootProject.file("designer/build/resources/main")),
    "gateway" to listOf(file("build/classes/java/main"), file("src/main/resources"))
)

val generateBuildId by tasks.registering {
    dependsOn(":common:classes", ":designer:classes", "compileJava")
    buildIdRoots.forEach { (_, dirs) -> dirs.forEach { inputs.files(fileTree(it)) } }
    val outFile = buildIdDir.map { it.file("mounted/build-id.txt") }
    outputs.file(outFile)
    doLast {
        val md = MessageDigest.getInstance("SHA-256")
        buildIdRoots.forEach { (jar, dirs) ->
            val entries = sortedMapOf<String, File>()
            dirs.filter { it.isDirectory }.forEach { root ->
                root.walkTopDown().filter { it.isFile }.forEach { f ->
                    val name = f.relativeTo(root).invariantSeparatorsPath
                    if (name != "META-INF/MANIFEST.MF" && !(jar == "gateway" && name == "mounted/build-id.txt")) {
                        if (entries.put(name, f) != null) {
                            throw GradleException("build id: $jar has two files for the jar entry $name")
                        }
                    }
                }
            }
            entries.forEach { (name, f) ->
                val bytes = f.readBytes()
                md.update("$jar/$name".toByteArray(Charsets.UTF_8))
                md.update(0.toByte())
                md.update(ByteBuffer.allocate(8).putLong(bytes.size.toLong()).array())
                md.update(bytes)
            }
        }
        val id = md.digest().joinToString("") { "%02x".format(it) }
        val f = outFile.get().asFile
        f.parentFile.mkdirs()
        f.writeText(id + "\n")
    }
}

sourceSets.named("main") {
    resources.srcDir(buildIdDir)
}

tasks.named("processResources") {
    dependsOn(generateBuildId)
}
