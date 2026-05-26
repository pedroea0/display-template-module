# Complete Guide: Building Ignition Modules from Scratch

## Table of Contents
1. [What is an Ignition Module?](#what-is-an-ignition-module)
2. [Prerequisites](#prerequisites)
3. [Project Structure Explained](#project-structure-explained)
4. [Step-by-Step Module Creation](#step-by-step-module-creation)
5. [Understanding the Build System](#understanding-the-build-system)
6. [Code Walkthrough](#code-walkthrough)
7. [Building and Testing](#building-and-testing)
8. [Troubleshooting](#troubleshooting)

---

## What is an Ignition Module?

An **Ignition Module** is a plugin that extends Ignition's functionality. Think of it as an add-on that adds new features to Ignition. Modules can:

- Add new components to the Designer
- Provide server-side functionality in the Gateway
- Create custom scripting functions
- Add new data sources or drivers
- Extend the web interface

### Module Scopes
Ignition modules can run in three different "scopes" (environments):

- **Gateway (G)**: Server-side functionality
- **Designer (D)**: Design-time tools for creating applications
- **Client (C)**: Client-side functionality for end users

Our module uses **Gateway** and **Designer** scopes.

---

## Prerequisites

Before building an Ignition module, you need:

1. **Java Development Kit (JDK) 17+**
   - Download from [Oracle](https://www.oracle.com/java/technologies/downloads/) or [OpenJDK](https://openjdk.org/)
   - Verify installation: `java -version`

2. **Ignition 8.3+** (for testing the module)

3. **Basic understanding of Java** (helpful but not required)

---

## Project Structure Explained

Our module follows this structure:

```
simple-tag-display/
├── build.gradle.kts              # Main build configuration
├── settings.gradle               # Project settings
├── gradlew.bat                   # Gradle wrapper (Windows)
├── gradlew                       # Gradle wrapper (Linux/Mac)
├── gradle/                       # Gradle wrapper files
├── common/                       # Shared code between scopes
│   ├── build.gradle.kts
│   └── src/main/java/.../common/
│       └── SimpleTagDisplayModule.java
├── gateway/                      # Gateway-scope code
│   ├── build.gradle.kts
│   └── src/main/java/.../gateway/
│       └── SimpleTagDisplayGatewayHook.java
├── designer/                     # Designer-scope code
│   ├── build.gradle.kts
│   └── src/main/java/.../designer/
│       └── SimpleTagDisplayDesignerHook.java
└── build/                        # Generated build output
    ├── moduleContent/
    │   ├── module.xml            # Module metadata
    │   ├── common-1.0.0.jar      # Common code
    │   ├── gateway-1.0.0.jar     # Gateway code
    │   └── designer-1.0.0.jar    # Designer code
    └── Simple-Tag-Display.unsigned.modl  # Final module file
```

### Why This Structure?

- **Separation of Concerns**: Each scope has its own code
- **Shared Code**: Common functionality goes in the `common/` module
- **Build System**: Gradle handles compilation and packaging
- **Output**: The `.modl` file is what you install in Ignition

---

## Step-by-Step Module Creation

### Step 1: Create the Root Build File (`build.gradle.kts`)

This is the main configuration file that tells Gradle how to build our module:

```kotlin
// Apply the Ignition module plugin
plugins {
    id("io.ia.sdk.modl") version("0.4.0")
}

// Set the SDK version we're targeting
val sdk_version by extra("8.3.1")

// Set the module version
allprojects {
    version = "1.0.0"
}

// Configure the module
ignitionModule {
    name.set("Simple Tag Display")                    // Display name
    fileName.set("Simple-Tag-Display")               // Output filename
    id.set("com.example.simpletagdisplay.SimpleTagDisplay")  // Unique ID
    moduleVersion.set("${project.version}")          // Version
    moduleDescription.set("A simple component...")    // Description
    requiredIgnitionVersion.set("8.3.0")             // Min Ignition version
    freeModule.set(true)                             // Free module (no license)
    skipModlSigning.set(true)                        // Skip signing for development
    
    // Define which projects belong to which scopes
    projectScopes.putAll(mapOf(
        ":common" to "GD",    // Common code used by Gateway and Designer
        ":designer" to "D",   // Designer-only code
        ":gateway" to "G"     // Gateway-only code
    ))
    
    // Register hook classes (entry points for each scope)
    hooks.putAll(mapOf(
        "com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook" to "G",
        "com.example.simpletagdisplay.designer.SimpleTagDisplayDesignerHook" to "D"
    ))
}
```

### Step 2: Create Project Settings (`settings.gradle`)

This file tells Gradle which subprojects to include:

```gradle
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            url = "https://nexus.inductiveautomation.com/repository/public" 
        }
    }
}

rootProject.name = "simple-tag-display"

dependencyResolutionManagement {
    repositories {
        maven {
            url "https://nexus.inductiveautomation.com/repository/public"
        }
        mavenCentral()
    }
}

include(":", ":common", ":gateway", ":designer")
```

### Step 3: Create the Common Module

The common module contains shared code:

**`common/build.gradle.kts`:**
```kotlin
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
}
```

**`common/src/main/java/.../common/SimpleTagDisplayModule.java`:**
```java
package com.example.simpletagdisplay.common;

public class SimpleTagDisplayModule {
    public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";
}
```

### Step 4: Create the Gateway Hook

The gateway hook runs on the server:

**`gateway/build.gradle.kts`:**
```kotlin
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
    compileOnly(project(":common"))
}
```

**`gateway/src/main/java/.../gateway/SimpleTagDisplayGatewayHook.java`:**
```java
package com.example.simpletagdisplay.gateway;

import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.gateway.model.AbstractGatewayModuleHook;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;

public class SimpleTagDisplayGatewayHook extends AbstractGatewayModuleHook {
    
    @Override
    public void setup(GatewayContext context) {
        // Called before startup - add extension points here
    }

    @Override
    public void startup(LicenseState activationState) {
        // Called when module starts - initialize functionality here
    }

    @Override
    public void shutdown() {
        // Called when module stops - cleanup here
    }

    @Override
    public boolean isFreeModule() {
        return true; // This is a free module
    }
}
```

### Step 5: Create the Designer Hook

The designer hook runs in the Designer application:

**`designer/build.gradle.kts`:**
```kotlin
plugins {
    `java-library`
}

java {
    toolchain {
        languageVersion.set(org.gradle.jvm.toolchain.JavaLanguageVersion.of(17))
    }
}

dependencies {
    compileOnly("com.inductiveautomation.ignitionsdk:designer-api:${rootProject.extra["sdk_version"]}")
    compileOnly("com.inductiveautomation.ignitionsdk:ignition-common:${rootProject.extra["sdk_version"]}")
    compileOnly(project(":common"))
}
```

**`designer/src/main/java/.../designer/SimpleTagDisplayDesignerHook.java`:**
```java
package com.example.simpletagdisplay.designer;

import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.designer.model.AbstractDesignerModuleHook;
import com.inductiveautomation.ignition.designer.model.DesignerContext;

public class SimpleTagDisplayDesignerHook extends AbstractDesignerModuleHook {

    @Override
    public void startup(DesignerContext context, LicenseState activationState) throws Exception {
        // Called when Designer starts - register components here
    }
}
```

---

## Understanding the Build System

### What is Gradle?

**Gradle** is a build automation tool that:
- Compiles Java code
- Manages dependencies
- Packages everything into a module file
- Handles the complex Ignition module format

### Key Concepts:

1. **Dependencies**: External libraries our code needs
   - `compileOnly`: Only needed during compilation, not at runtime
   - `implementation`: Needed at runtime

2. **Plugins**: Extend Gradle's functionality
   - `java-library`: Adds Java compilation support
   - `io.ia.sdk.modl`: Adds Ignition module packaging

3. **Tasks**: Actions Gradle can perform
   - `compileJava`: Compiles Java source code
   - `jar`: Creates JAR files
   - `build`: Runs all build tasks

### Build Process:

1. **Compile**: Convert Java source to bytecode
2. **Package**: Create JAR files for each scope
3. **Assemble**: Combine everything into module structure
4. **Sign**: Add digital signature (skipped for development)
5. **Package**: Create final `.modl` file

---

## Code Walkthrough

### The Gateway Hook

```java
public class SimpleTagDisplayGatewayHook extends AbstractGatewayModuleHook {
```

**What this does:**
- Extends the base class for Gateway modules
- Provides lifecycle methods that Ignition calls
- Runs on the server when the module is loaded

**Key Methods:**
- `setup()`: Called before startup - add extension points
- `startup()`: Called when module starts - initialize functionality
- `shutdown()`: Called when module stops - cleanup
- `isFreeModule()`: Tells Ignition this is a free module

### The Designer Hook

```java
public class SimpleTagDisplayDesignerHook extends AbstractDesignerModuleHook {
```

**What this does:**
- Extends the base class for Designer modules
- Runs in the Designer application
- Can register new components, tools, etc.

### The Common Module

```java
public class SimpleTagDisplayModule {
    public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";
}
```

**What this does:**
- Contains shared constants and utilities
- Available to both Gateway and Designer code
- Provides a central place for module identification

---

## Building and Testing

### Building the Module

1. **Navigate to the module directory:**
   ```bash
   cd simple-tag-display
   ```

2. **Clean and build:**
   ```bash
   # Windows
   .\gradlew.bat clean build
   
   # Linux/Mac
   ./gradlew clean build
   ```

3. **Check the output:**
   - Look for `BUILD SUCCESSFUL`
   - Find the `.modl` file in `build/` directory

### Installing in Ignition

1. **Copy the module file:**
   - Copy `Simple-Tag-Display.unsigned.modl` to your Ignition Gateway

2. **Install the module:**
   - Go to **Configure** → **Modules**
   - Click **Install Module**
   - Select the `.modl` file
   - Accept the certificate when prompted

3. **Verify installation:**
   - Go to **Status** → **Modules**
   - Look for "Simple Tag Display" in the list
   - Status should be "Active"

---

## Troubleshooting

### Common Issues:

1. **"Module failed to enable"**
   - Check that all dependencies are correct
   - Verify the module ID is unique
   - Ensure the required Ignition version is correct

2. **"Certificate has not been accepted"**
   - This is normal for unsigned modules
   - Accept the certificate in the Gateway configuration

3. **Build failures**
   - Check Java version (needs 17+)
   - Verify all dependencies are available
   - Check for compilation errors in the output

4. **Version compatibility errors**
   - Ensure `requiredIgnitionVersion` matches your Ignition version
   - Update SDK version if needed

### Debug Tips:

1. **Check the build output:**
   - Look for error messages in the Gradle output
   - Check the `build/moduleContent/module.xml` file

2. **Verify module structure:**
   - Ensure all JAR files are present in `build/moduleContent/`
   - Check that the module.xml is correctly formatted

3. **Test incrementally:**
   - Start with a minimal module
   - Add functionality gradually
   - Test after each change

---

## Next Steps

Now that you understand the basics:

1. **Add functionality** to your hooks
2. **Create components** in the Designer hook
3. **Add server-side features** in the Gateway hook
4. **Test thoroughly** before deploying

### Resources:

- [Ignition SDK Documentation](https://www.sdk-docs.inductiveautomation.com/)
- [Gradle Documentation](https://docs.gradle.org/)
- [Java Documentation](https://docs.oracle.com/en/java/)

### Example Extensions:

- Add custom scripting functions
- Create new Perspective components
- Add Gateway configuration panels
- Implement custom data sources

Remember: Start simple and build up complexity gradually. The module system is powerful but can be complex, so take it step by step!
