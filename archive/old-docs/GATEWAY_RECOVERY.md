# Gateway Won't Restart After Installing This Module

If the Ignition gateway is stuck restarting after you installed the Tag Display module, the cause is usually **module bytecode mismatch**: the module was built with a newer Java (e.g. Java 25) and Ignition runs on **Java 11 or 17**, so it cannot load the module and can hang during startup.

## 1. Recover the gateway (get it running again)

You need to **remove or disable the module** so the gateway can start.

### Option A: Remove the module file (easiest if you can access the server)

1. **Stop the gateway**  
   - Use Windows Services and stop the Ignition service, or  
   - Use Task Manager and end any `java` / `ignition` processes for the gateway, or  
   - From the gateway install folder run: `stop.bat` (or the stop script for your OS).

2. **Remove the Tag Display module**
   - Go to the Ignition **installation directory** (e.g. `C:\Program Files\Inductive Automation\Ignition`).
   - Open the **user-lib** (or **lib**) folder where modules are stored.  
     Common path: `data/db/modules/` or the folder where you placed/copied the `.modl` file.
   - **Delete** (or move aside) **Tag-Display.modl** (or `Simple-Tag-Display.modl`).

3. **Start the gateway again**  
   - Start the Ignition service or run `start.bat` (or equivalent).  
   - The gateway should come up without loading this module.

### Option B: Use Safe Mode (if the gateway has it)

Some Ignition setups support a safe/maintenance mode that skips loading modules. Check the Ignition docs for your version (e.g. “Safe Mode” or “Maintenance Mode”) and start the gateway in that mode, then remove or disable the Tag Display module from the UI or config.

### Option C: Edit gateway config (if you know the path)

If you know where the gateway stores its config (e.g. `ignition.conf` or a modules list), you can remove the reference to the Tag Display module there, then restart. Only do this if you are comfortable editing the gateway configuration.

---

## 2. Install a compatible build

The module **must** be built so that it compiles to **Java 17 (or 11) bytecode** so Ignition’s JVM can load it.

- **Option 1 – Build with JDK 17**  
  Install **JDK 17** (e.g. [Eclipse Temurin](https://adoptium.net/)), set `JAVA_HOME` to it, and run:
  - `gradlew.bat build`
  - `sign-module.ps1`  
  Use the new `Tag-Display.modl` from `build/`.

- **Option 2 – Build with JDK 25 but target Java 17**  
  This project is configured so that when you build with Java 25, Gradle uses `--release 17`, producing Java 17 bytecode.  
  - Delete the `build` folders under `common`, `designer`, and `gateway` (and the root `build` if you want a full clean).
  - Set `JAVA_HOME` to your JDK 25 install.
  - Run `gradlew.bat build` then `sign-module.ps1`.  
  Install the newly built `Tag-Display.modl`.

After installing a build that targets Java 17, the gateway should start and load the module normally.
