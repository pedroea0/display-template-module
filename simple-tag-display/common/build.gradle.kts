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
// Writes the module version into a properties file bundled in the common jar.
// SimpleTagDisplayModule reads it and appends "?v=<version>" to the browser
// resource URL for simpletagdisplay.js.
//
// Why: the gateway serves the mounted resource path with NO cache headers — no
// Cache-Control, no ETag, no Last-Modified (verified against a live gateway).
// With no validator, browsers cache heuristically and may never revalidate. A
// Perspective session recovers on a hard refresh, but the Designer's embedded
// browser has no such gesture, so it keeps rendering the JS from whichever
// build it first loaded. Changing the URL each version sidesteps the cache
// entirely: a new version is simply a different URL.
//
// NOTE: line comments, not a block comment, on purpose. Kotlin block comments
// NEST, so a URL path containing a slash-star sequence inside one opens a
// nested comment and the single closing delimiter then leaves the outer
// comment open — silently swallowing the rest of this file. That cost a while
// to find: everything below simply stopped being registered, with no error.
// ---------------------------------------------------------------------------
val versionResourceDir = layout.buildDirectory.dir("generated/version-resources")

val generateVersionResource by tasks.registering {
    val outFile = versionResourceDir.map {
        it.file("com/example/simpletagdisplay/common/module-version.properties")
    }
    val moduleVersion = project.version.toString()
    inputs.property("moduleVersion", moduleVersion)   // re-runs when the version changes
    outputs.file(outFile)
    doLast {
        val f = outFile.get().asFile
        f.parentFile.mkdirs()
        f.writeText("version=$moduleVersion\n")
    }
}

sourceSets.named("main") {
    resources.srcDir(versionResourceDir)
}

tasks.named("processResources") {
    dependsOn(generateVersionResource)
}
