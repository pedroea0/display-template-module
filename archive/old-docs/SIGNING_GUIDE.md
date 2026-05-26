# Module Signing Guide

This guide will help you sign the Simple Tag Display module so it can be installed on Ignition systems that are not in developer mode.

## Prerequisites

1. **Java 11+** installed and on your PATH
2. **A Java Keystore** (`.jks` or `.pfx` format) containing a code signing certificate
3. **Module Signer Tool** (`module-signer.jar`)

## Step 1: Create a Keystore (if you don't have one)

If you need to create a self-signed certificate for testing/internal use:

```bash
keytool -genkeypair -alias simpletagdisplay -keyalg RSA -keysize 2048 -keystore simpletagdisplay.jks -validity 365 -storepass changeit -keypass changeit -dname "CN=Simple Tag Display, OU=Development, O=Your Company, L=City, ST=State, C=US"
```

**Important**: Replace the passwords (`changeit`) and certificate details with your own secure values.

For production use, you should obtain a code signing certificate from a Certificate Authority (CA).

## Step 2: Build the Module Signer Tool

The module-signer tool needs to be built. You have two options:

### Option A: Build with Gradle (Recommended - Already Done!)

The module-signer has been built using Gradle. The JAR is located at:
```
module-signer/build/libs/module-signer-1.0.0-jar-with-dependencies.jar
```

If you need to rebuild it:
```bash
cd "C:\Users\PedroEspinosa\Desktop\Rocks\Display Template Module\module-signer"
..\simple-tag-display\gradlew.bat -p . build
```

### Option B: Build with Maven (if Maven is installed)

```bash
cd "C:\Users\PedroEspinosa\Desktop\Rocks\Display Template Module\module-signer"
mvn clean package
```

This will create `target/module-signer-jar-with-dependencies.jar`

## Step 3: Sign the Module

Once you have:
- Your keystore file (e.g., `simpletagdisplay.jks`)
- The module-signer.jar
- Your unsigned module (`build/Simple-Tag-Display.unsigned.modl`)

Run the signing command:

```bash
java -jar module-signer.jar ^
    -keystore=path/to/your/keystore.jks ^
    -keystore-pwd=yourKeystorePassword ^
    -alias=simpletagdisplay ^
    -alias-pwd=yourAliasPassword ^
    -chain=path/to/certificate.p7b ^
    -module-in=build/Simple-Tag-Display.unsigned.modl ^
    -module-out=build/Simple-Tag-Display.modl
```

**Note for Windows**: Use `^` for line continuation in Command Prompt, or use backticks `` ` `` in PowerShell.

### If you're using a self-signed certificate (no chain file):

You can omit the `-chain` parameter if you're using a self-signed certificate:

```bash
java -jar module-signer.jar ^
    -keystore=simpletagdisplay.jks ^
    -keystore-pwd=changeit ^
    -alias=simpletagdisplay ^
    -alias-pwd=changeit ^
    -module-in=build/Simple-Tag-Display.unsigned.modl ^
    -module-out=build/Simple-Tag-Display.modl
```

## Step 4: Update Build Configuration (Optional)

If you want to enable signing through Gradle in the future, you can:

1. Create a `sign.props` file in the project root (based on `sign.props.example` from the example)
2. Set `skipModlSigning.set(false)` in `build.gradle.kts`

However, for now, manual signing with the module-signer tool is the recommended approach.

## Troubleshooting

- **"Keystore file not found"**: Ensure the path to your keystore is correct
- **"Wrong password"**: Double-check your keystore and alias passwords
- **"Certificate chain not found"**: If using a CA certificate, ensure the chain file (`.p7b`) is in the correct location
- **"Module file not found"**: Ensure you've built the module first (`gradlew build`)

## References

- [Ignition SDK Module Signing Documentation](https://www.sdk-docs.inductiveautomation.com/docs/8.3/getting-started/create-a-module/module-signing)
- [Keystore Explorer](http://keystore-explorer.sourceforge.net/downloads.php) - GUI tool for managing keystores

