# Development Workflow for Signed Modules

## Making Changes to a Signed Module

Yes, you can absolutely continue editing your module even after it's been signed! Here's the workflow:

## Development Cycle

### 1. Make Your Edits
Edit any source files in:
- `common/src/main/java/` - Java code
- `common/src/main/resources/` - Resources (props.json, icons, etc.)
- `gateway/src/main/java/` - Gateway code
- `gateway/src/main/resources/` - Gateway resources (JS files)
- `designer/src/main/java/` - Designer code

### 2. Rebuild the Module
After making changes, rebuild the module:

```bash
cd simple-tag-display
.\gradlew.bat build
```

This will create a new unsigned module at: `build/Simple-Tag-Display.unsigned.modl`

### 3. Re-sign the Module (if needed)
If you need to install on systems that aren't in developer mode, re-sign it:

**Option A: Use the signing script**
```bash
.\sign-module.bat
```

**Option B: Use PowerShell script**
```powershell
.\sign-module.ps1
```

**Option C: Manual signing**
```bash
java -jar ..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar ^
    -keystore=simpletagdisplay.jks ^
    -keystore-pwd=simpletagdisplay123 ^
    -alias=simpletagdisplay ^
    -alias-pwd=simpletagdisplay123 ^
    -chain=simpletagdisplay.p7b ^
    -module-in=build\Simple-Tag-Display.unsigned.modl ^
    -module-out=build\Simple-Tag-Display.modl
```

## Quick Development (Developer Mode)

If you're testing in **developer mode**, you don't need to sign the module at all! Just:

1. Make your edits
2. Run `.\gradlew.bat build`
3. Install the unsigned module (`Simple-Tag-Display.unsigned.modl`)

Developer mode allows unsigned modules to be installed for testing.

## Important Notes

- **Each time you rebuild**, a new unsigned module is created
- **You must re-sign** if you want to install on production systems (non-developer mode)
- **The keystore and certificate** (`simpletagdisplay.jks` and `simpletagdisplay.p7b`) are reusable - you don't need to recreate them
- **Version numbers**: If you change the module version in `build.gradle.kts`, make sure to update it consistently

## Version Management

To update the module version, edit `build.gradle.kts`:

```kotlin
allprojects {
    version = "1.0.1"  // Increment this for new releases
}
```

Then rebuild and re-sign as needed.

