# Simple Tag Display Module

A simplified Ignition module component for displaying tag names and values with automatic tag path parsing.

## Features

- **Simple Interface**: Two labels - one for tag name, one for tag value
- **Automatic Tag Name Extraction**: Automatically extracts the tag name from the provided tag path
- **Tag Value Reading**: Automatically reads and displays the current value of the specified tag
- **Configurable Display**: Option to show/hide tag name and tag value independently
- **Error Handling**: Shows appropriate messages for disconnected tags or invalid paths

## Component Properties

- **TagPath** (String): The full path to the tag you want to display (e.g., `[ProviderName]Folder/Subfolder/TagName`)
- **showTagName** (Boolean): Whether to display the tag name label (default: true)
- **showTagValue** (Boolean): Whether to display the tag value label (default: true)

## Usage

1. Install the module in your Ignition Gateway
2. In Ignition Designer, the component will be available in the component palette
3. Drag the component onto your perspective view
4. Configure the TagPath property with your desired tag path
5. Optionally configure the showTagName and showTagValue properties

## Tag Path Examples

- `[UPE_Extrusion_Provider]Extrusion 1/MHS_27MM/Temperature/Extruder Zone 1/Auto Setpoint/Value`
- `[OPC_UA]Device1.Temperature.Sensor1`
- `Folder/Subfolder/TagName`

## Display Behavior

- **Valid Tag Path**: Shows the extracted tag name and current tag value
- **No Tag Path**: Shows "No Tag Selected" and "No Tag Path"
- **Disconnected Tag**: Shows the tag name and "Disconnected"
- **Invalid Path**: Shows "No Tag Selected" and "No Tag Path"

## Building the Module

**Use Java 17** so the module bytecode is compatible with Ignition's JVM. Set `JAVA_HOME` to your JDK 17 before building.

**Windows (PowerShell):**
```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$env:Path = "$env:JAVA_HOME\bin;" + $env:Path
.\gradlew.bat build
.\sign-module.ps1
```

Or run **`.\build-and-sign.ps1`** to build and sign in one step (it will use Java 17 if found at `C:\Program Files\Java\jdk-17`).

**Linux/Mac:** Set `JAVA_HOME` to JDK 17, then run `./gradlew build` and sign as needed.

The built module is **`build/Tag-Display.unsigned.modl`** (or **`build/Tag-Display.modl`** after signing).

## Module Information

- **Module ID**: `com.example.simpletagdisplay.SimpleTagDisplay`
- **Version**: 1.0.0
- **Required Ignition Version**: 8.1.20+
- **Scopes**: Gateway (G), Designer (D)
- **License**: Free module
