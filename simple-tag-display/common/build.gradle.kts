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
    // add common scoped dependencies here
    compileOnly("com.inductiveautomation.ignitionsdk:ignition-common:${rootProject.extra["sdk_version"]}")
    compileOnly("com.inductiveautomation.ignitionsdk:perspective-common:${rootProject.extra["sdk_version"]}")
}

// ---------------------------------------------------------------------------
// Build-time version stamp
// ---------------------------------------------------------------------------
// Writes module-version.properties into the common jar:
//
//     version=2.0.0
//     resourceVersion=2.0.0-<first 8 hex of SHA-256 over every mounted file>
//     protocol=2
//
// SimpleTagDisplayModule reads it and appends "?v=<resourceVersion>" to every
// browser-resource URL (and the chart appends it to the lazily loaded uPlot).
//
// Why a content hash: the gateway serves the mounted folder with no validator
// headers (no ETag / Last-Modified), so browsers cache it heuristically and
// the Designer's embedded browser has no hard-refresh gesture. v1 used the
// module version as the cache buster, which silently failed whenever a JS
// change shipped without a version bump. Hashing the files makes "the JS
// changed" and "the URL changed" the same event.
//
// The hash input is the relative path (forward slashes) plus the bytes of
// every file under gateway/src/main/resources/mounted, in sorted path order,
// so it is stable across machines and checkouts.
//
// A missing properties file is a build error, not a silent "dev" fallback:
// SimpleTagDisplayModule throws at class init when it is absent.
//
// NOTE: line comments, not a block comment, on purpose. Kotlin block comments
// NEST, so a path glob containing a slash-star sequence inside one opens a
// nested comment and silently swallows the rest of this file.
// ---------------------------------------------------------------------------
val versionResourceDir = layout.buildDirectory.dir("generated/version-resources")
val mountedDir = rootProject.file("gateway/src/main/resources/mounted")

val generateVersionResource by tasks.registering {
    val outFile = versionResourceDir.map {
        it.file("com/example/simpletagdisplay/common/module-version.properties")
    }
    val moduleVersion = project.version.toString()
    inputs.property("moduleVersion", moduleVersion)   // re-runs when the version changes
    inputs.dir(mountedDir)                            // ... and when any mounted file changes
    outputs.file(outFile)
    doLast {
        // (imported at the top: inside this script `java` resolves to the java{} extension)
        val md = MessageDigest.getInstance("SHA-256")
        mountedDir.walkTopDown()
            .filter { it.isFile }
            .sortedBy { it.relativeTo(mountedDir).invariantSeparatorsPath }
            .forEach {
                md.update(it.relativeTo(mountedDir).invariantSeparatorsPath.toByteArray(Charsets.UTF_8))
                md.update(it.readBytes())
            }
        val hash = md.digest().joinToString("") { "%02x".format(it) }.take(8)
        val f = outFile.get().asFile
        f.parentFile.mkdirs()
        f.writeText("version=$moduleVersion\nresourceVersion=$moduleVersion-$hash\nprotocol=2\n")
    }
}

sourceSets.named("main") {
    resources.srcDir(versionResourceDir)
}

tasks.named("processResources") {
    dependsOn(generateVersionResource)
}
