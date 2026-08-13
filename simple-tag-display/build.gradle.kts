/*
 * Tag Display Module
 * A component for displaying tag names and values with automatic tag path parsing.
 */

plugins {
    id("io.ia.sdk.modl") version("0.4.0")
}

val sdk_version by extra("8.3.1")

allprojects {
    version = "1.1.5"
}

ignitionModule {
    /*
     * Human readable name of the module, as will be displayed on the gateway status page
     */
    name.set("Tag Display")

    /*
     * Name of the '.modl' file to be created, without file extension.
     */
    fileName.set("Tag-Display")
    
    /*
     * Unique identifier for the module.  Reverse domain convention is recommended
     */
    id.set("com.example.simpletagdisplay.SimpleTagDisplay")

    /*
     * Version of the module.
     */
    moduleVersion.set("${project.version}")

    moduleDescription.set("A simple component for displaying tag names and values with automatic tag path parsing.")

    /*
     * Minimum version of Ignition required for the module to function correctly.
     */
    requiredIgnitionVersion.set("8.3.0")
    
    /*
     * Define which projects belong to which scopes
     */
    projectScopes.putAll(mapOf(
        ":common" to "GD",
        ":designer" to "D",
        ":gateway" to "G"
    ))

    /*
     * Add your module dependencies here
     */
    moduleDependencies.set(mapOf(
        "com.inductiveautomation.perspective" to "GD"
    ))

    /*
     * Register hook classes for each scope
     */
    hooks.putAll(mapOf(
        "com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook" to "G",
        "com.example.simpletagdisplay.designer.SimpleTagDisplayDesignerHook" to "D"
    ))

    /*
     * Optional unsigned modl settings. If true, modl signing will be skipped.
     */
    skipModlSigning.set(true)
    
    /*
     * Set this as a free module
     */
    freeModule.set(true)
}
