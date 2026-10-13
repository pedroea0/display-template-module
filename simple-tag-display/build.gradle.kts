// =============================================================================
//  Display Template & Click-to-Graph — Ignition Perspective module (v2)
// =============================================================================
//  Two Perspective components (component ids unchanged since v1):
//    com.example.simpletagdisplay.SimpleTagDisplay  palette "Display Template"
//    com.example.simpletagdisplay.CtgChart          palette "Click To Graph Chart"
//
//  NOTE: line comments only in every .gradle.kts of this build. Kotlin block
//  comments NEST, so a path glob containing a slash-star inside one silently
//  comments out the rest of the file and the build still "succeeds".
// =============================================================================

plugins {
    id("io.ia.sdk.modl") version("0.4.0")
}

// SDK artifacts we compile against (Ignition 8.3.1 / Perspective 3.3.1). The
// module runs on any 8.3.x gateway from 8.3.1 on (requiredIgnitionVersion).
val sdk_version by extra("8.3.1")

allprojects {
    // Module version. The browser-resource cache buster is a content hash
    // (common/build.gradle.kts), so frontend changes do not need a manual
    // version bump.
    version = "2.0.0"
}

ignitionModule {
    // Human readable name, shown on the gateway's module page.
    name.set("Display Template & Click-to-Graph")

    // Name of the .modl file (without extension). Kept from v1 so the recovery
    // docs and the deploy script keep matching (Tag-Display*.modl).
    fileName.set("Tag-Display")

    // Unique module id. UNCHANGED since v1: existing installs upgrade in place.
    id.set("com.example.simpletagdisplay.SimpleTagDisplay")

    moduleVersion.set("${project.version}")

    moduleDescription.set(
        "Display Template (live tag value, setpoints, alarms, trend menu) and Click-to-Graph trend chart for Perspective."
    )

    // We compile against SDK 8.3.1 / Perspective 3.3.1.
    requiredIgnitionVersion.set("8.3.1")

    projectScopes.putAll(mapOf(
        ":common" to "GD",
        ":designer" to "D",
        ":gateway" to "G"
    ))

    moduleDependencies.set(mapOf(
        "com.inductiveautomation.perspective" to "GD"
    ))

    hooks.putAll(mapOf(
        "com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook" to "G",
        "com.example.simpletagdisplay.designer.SimpleTagDisplayDesignerHook" to "D"
    ))

    // Signing is done by sign-module.ps1 with the module-signer jar.
    skipModlSigning.set(true)

    freeModule.set(true)
}

// -----------------------------------------------------------------------------
// Never ship stale subproject jars.
// assembleModlStructure copies every subproject jar into build/moduleContent
// and never removes old ones, so after a version bump the .modl would carry
// BOTH, e.g. gateway-1.1.5.jar and gateway-2.0.0.jar (whichever the classloader
// picks first wins). `gradlew clean` is not an option on OneDrive (it fails on the
// cloud-file reparse points), so the folder is pruned right before assembly.
// build-and-sign.ps1 additionally verifies the finished .modl (exit 3).
// -----------------------------------------------------------------------------
tasks.named("assembleModlStructure") {
    doFirst {
        delete(layout.buildDirectory.dir("moduleContent"))
    }
}
