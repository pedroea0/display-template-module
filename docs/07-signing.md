# 07 — Module signing

Ignition modules can be signed (cryptographically) so the gateway can verify they came from a trusted source. This doc explains:

- What signing actually does to a `.modl`.
- How the bundled dev keystore works.
- How to generate and use your own keystore.
- When you can skip signing entirely.

## What signing does

A `.modl` is a zip file. The signer:

1. Reads every non-directory file in the zip.
2. Computes a **SHA-256 with RSA** signature of each file's bytes using a **private key** loaded from a keystore.
3. Base64-encodes each signature.
4. Writes a `signatures.properties` file back into the zip mapping `filename → base64signature`.
5. Adds the **public certificate chain** (the `.p7b`) to the zip so the verifier can validate the signatures.

When Ignition installs the module, it re-computes each file's signature and verifies it against `signatures.properties` using the bundled certificate. If anything was tampered with after signing, verification fails and the install is rejected.

This is **integrity verification**, not authorization. A self-signed cert proves the file hasn't been altered since signing, but doesn't prove who signed it (unless your gateway is configured to trust a specific cert chain).

## The bundled dev keystore

Two files in `simple-tag-display/`:

- `simpletagdisplay.jks` — a Java KeyStore containing the private key.
- `simpletagdisplay.p7b` — the public certificate chain (PKCS#7 format).

Both are committed to the repo. The credentials are in [sign-module.ps1](../simple-tag-display/sign-module.ps1):

```powershell
$KEYSTORE = "simpletagdisplay.jks"
$KEYSTORE_PWD = "simpletagdisplay123"
$ALIAS = "simpletagdisplay"
$ALIAS_PWD = "simpletagdisplay123"
$CERT_CHAIN = "simpletagdisplay.p7b"
```

This is **fine for dev** because:
- The cert is self-signed (no public trust anchor).
- Anyone with the repo can sign with it.
- It's only useful against gateways that accept the cert (which is most internal gateways).

It is **not fine for production / external publishing** because anyone with the repo can produce a `.modl` that claims to come from you. Generate your own keystore for any module you ship outside of internal trusted networks.

## Generating your own keystore

You need `keytool` (ships with JDK).

```powershell
# 1. Generate a new keystore with a 2048-bit RSA keypair, valid 5 years
keytool -genkey -alias mymodule `
        -keyalg RSA -keysize 2048 -validity 1825 `
        -keystore mymodule.jks -storetype JKS `
        -dname "CN=My Company Tag Display, OU=Engineering, O=My Company, L=City, ST=State, C=US" `
        -storepass mystorepass -keypass mystorepass

# 2. Export the public certificate chain as PKCS#7
keytool -export -alias mymodule `
        -keystore mymodule.jks -storepass mystorepass `
        -rfc -file mymodule.p7b
```

Adjust:
- **Alias** (`mymodule`) — internal name for the key inside the store.
- **Validity** (1825 days = ~5 years) — how long the cert is valid.
- **`-dname`** — the X.500 distinguished name embedded in the certificate.
- **Passwords** — `storepass` is the store-level password; `keypass` protects the private key entry. The signer expects both to be the same in the current script — keep them aligned or update `sign-module.ps1`.

Drop both files into `simple-tag-display/` (or somewhere else and update the paths in `sign-module.ps1`).

## Updating `sign-module.ps1` to use your keystore

Open [sign-module.ps1](../simple-tag-display/sign-module.ps1) and update:

```powershell
$KEYSTORE     = "mymodule.jks"
$KEYSTORE_PWD = "mystorepass"
$ALIAS        = "mymodule"
$ALIAS_PWD    = "mystorepass"
$CERT_CHAIN   = "mymodule.p7b"
```

Then run `.\simple-tag-display\build-and-sign.ps1` as usual. The signed `.modl` will be signed with your key.

**Don't commit your real `.jks` to a public repo.** Add `*.jks` to `.gitignore`, store the keystore in a secrets manager (1Password, Vault, GitHub Actions secrets), and inject the credentials at build time. For CI, you can base64-encode the keystore into a secret:

```yaml
# GitHub Actions example
- name: Restore keystore
  run: |
    [System.Convert]::FromBase64String("${{ secrets.KEYSTORE_B64 }}") `
      | Set-Content -Path simple-tag-display\mymodule.jks -Encoding Byte
  shell: pwsh
```

## What `module-signer` is, briefly

The signer is a small Java tool — see [module-signer/src/main/java/com/inductiveautomation/ignitionsdk/ModuleSigner.java](../module-signer/src/main/java/com/inductiveautomation/ignitionsdk/ModuleSigner.java). It's a stripped-down version of Inductive Automation's reference module-signing tool, packaged as a fat JAR (with Commons CLI and Commons IO inlined) so it runs with just `java -jar` and no extra setup.

The tool accepts these flags (passed by `sign-module.ps1`):

| Flag | Required | Purpose |
|---|---|---|
| `-keystore=PATH` | yes | JKS file with the private key |
| `-keystore-pwd=PWD` | yes | Store password |
| `-alias=NAME` | yes | Key alias within the store |
| `-alias-pwd=PWD` | yes | Key password |
| `-chain=PATH` | no | PKCS#7 cert chain. If missing, signer emits a "bare" signed module that only works with **Allow Unsigned Modules** enabled. |
| `-module-in=PATH` | yes | Unsigned `.modl` to sign |
| `-module-out=PATH` | yes | Signed `.modl` to write |

The fat JAR is built once by `build-and-sign.ps1` step 4 and cached. To force a rebuild:

```powershell
cd module-signer
.\..\simple-tag-display\gradlew.bat clean build
```

## Skipping signing entirely

If your gateway has **Allow Unsigned Modules** enabled (under **Config → Gateway Settings → Module Settings**), you can install an unsigned `.modl` directly. Two ways:

### Option A: skip the sign step

Just upload `simple-tag-display/build/Tag-Display.unsigned.modl` (the file Gradle produced before signing). The gateway will warn that it's unsigned but install it.

### Option B: tell the Gradle plugin to skip signing

Already done in [build.gradle.kts](../simple-tag-display/build.gradle.kts):

```kotlin
skipModlSigning.set(true)
```

This makes the plugin produce `Tag-Display.unsigned.modl` instead of trying to sign. Our `sign-module.ps1` then signs it ourselves.

If you set `skipModlSigning.set(false)`, the Gradle plugin will try to sign the module itself and will need its own keystore config in the build file (see the [Ignition module SDK docs](https://github.com/inductiveautomation/ignition-module-tools)).

## Cert expiration

Self-signed certs expire after the validity you set with `-validity` at generation. When the cert expires:
- Signing still works (the signer doesn't check expiration on its own cert).
- But Ignition's signature verification will reject the module on install.

To renew:
1. Generate a new keypair (same `-alias` and password).
2. Re-export the `.p7b`.
3. Re-sign and reinstall.

If you keep the same key material and just want a longer expiration, you can also use `keytool -selfcert -validity ...` to issue a new cert on the existing key.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `Module signing failed` | Wrong password or alias in `sign-module.ps1` | Verify all four `KEYSTORE_PWD`/`ALIAS`/`ALIAS_PWD` values match the keystore |
| `Keystore not found` | `simpletagdisplay.jks` deleted or path wrong | Restore from git, or generate a new one |
| `module-signer.jar not found` | First-time run, signer JAR not built | `build-and-sign.ps1` handles this; manually: `cd module-signer; ..\simple-tag-display\gradlew.bat build` |
| Gateway rejects install with "signature invalid" | Cert expired or doesn't match the one used to sign | Regenerate the keypair and re-sign |
| Gateway rejects install with "module is not signed" | Used `Tag-Display.unsigned.modl` and *Allow Unsigned* is disabled | Either enable the gateway setting or use the signed `.modl` |

---

Next: [08-extending-and-contributing.md](08-extending-and-contributing.md).
