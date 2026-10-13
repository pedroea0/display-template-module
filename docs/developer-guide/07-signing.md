<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Signing**

<!-- /nav:top -->

# 07 — Signing

Ignition modules are signed so a gateway administrator can see who built them and accept that publisher once. This page
explains the development certificate in the repository, how to sign with your own certificate, and what a purchased
code-signing certificate needs.

**On this page**

- [How signing works here](#how-signing-works-here)
- [The development certificate](#the-development-certificate)
- [Signing with your own keystore](#signing-with-your-own-keystore)
- [Signing with a purchased certificate](#signing-with-a-purchased-certificate)
- [Running the signer directly](#running-the-signer-directly)
- [Checking a signed module](#checking-a-signed-module)

---

## How signing works here

`sign-module.ps1` (called by `build-and-sign.ps1`) runs the small `module-signer` tool (built from `module-signer/`)
on `build\Tag-Display.unsigned.modl` and writes `build\Tag-Display.modl`. The signer adds two entries to the module:
`signatures.properties` (an RSA signature per file) and `certificates.p7b` (your certificate chain). On install the
gateway shows the certificate and asks the administrator to accept it (the deploy script accepts it through the API).

Passwords are handed to the signer through **environment variables** of the signer process, never on its command line,
where process lists and endpoint-security logs would record them.

## The development certificate

`simple-tag-display/simpletagdisplay.jks` and `simpletagdisplay.p7b` are committed on purpose: a self-signed
development key (`CN=Simple Tag Display, OU=Development, O=Example`) whose password is in `sign-module.ps1`. Anyone with
the repository can sign with it, so it proves nothing about who built a module. It is fine for test gateways and
**never** for production. Without `CTG_KEYSTORE_PASSWORD` the script uses it and prints:

```
WARNING: signing with the public DEV certificate (not for production). Set CTG_KEYSTORE_PASSWORD (and CTG_KEYSTORE, CTG_CERT_CHAIN, CTG_KEY_ALIAS) to sign with your own certificate.
```

The development certificate is valid until **2027-01-07**. After that date, generate a new one with the commands below
(alias `simpletagdisplay`) or sign with your own.

## Signing with your own keystore

`sign-module.ps1` reads these environment variables:

| Variable | Meaning | Default when unset |
|---|---|---|
| `CTG_KEYSTORE` | path to the keystore: `.jks`, or `.pfx` for PKCS#12 | **required** with `CTG_KEYSTORE_PASSWORD` |
| `CTG_CERT_CHAIN` | path to the certificate chain (PEM or PKCS#7); must contain the signing key's certificate | **required** with `CTG_KEYSTORE_PASSWORD` |
| `CTG_KEY_ALIAS` | key alias in the keystore | `simpletagdisplay` |
| `CTG_KEYSTORE_PASSWORD` | keystore password; setting it signs with your keystore and chain instead of the dev files | – (the dev keystore and dev chain are used) |
| `CTG_CERT_PASSWORD` | key password, when it differs from the keystore password | `CTG_KEYSTORE_PASSWORD` |
| `JAVA17_HOME` | JDK 17 used to run the signer | `C:\Program Files\Java\jdk-17` |

Create a key and its certificate (self-signed, for an internal publisher) and sign:

```powershell
$kt = "C:\Program Files\Java\jdk-17\bin\keytool.exe"
& $kt -genkeypair -alias tagdisplay -keyalg RSA -keysize 3072 -validity 1095 `
      -keystore C:\secure\prod-tagdisplay.jks -storetype JKS `
      -dname "CN=Example Corp Module Signing, O=Example Corp, C=US"
& $kt -exportcert -rfc -alias tagdisplay -keystore C:\secure\prod-tagdisplay.jks -file C:\secure\prod-tagdisplay.p7b

$env:CTG_KEYSTORE      = "C:\secure\prod-tagdisplay.jks"
$env:CTG_CERT_CHAIN    = "C:\secure\prod-tagdisplay.p7b"
$env:CTG_KEY_ALIAS     = "tagdisplay"
$env:CTG_KEYSTORE_PASSWORD = Read-Host "Keystore password"      # or from your secret store
.\simple-tag-display\build-and-sign.ps1
```

`sign-module.ps1` refuses to sign (exit 1) when `CTG_KEYSTORE_PASSWORD` is set without `CTG_KEYSTORE` and
`CTG_CERT_CHAIN`, when any `CTG_KEYSTORE` / `CTG_CERT_CHAIN` / `CTG_KEY_ALIAS` / `CTG_CERT_PASSWORD` is set without
`CTG_KEYSTORE_PASSWORD` (a mistyped variable name never falls back to the dev certificate), and when the signing key's
certificate is not in the chain (compared by SHA-256 fingerprint with `keytool`; a mismatch would only fail at install
time on the gateway).

(`keytool` asks for the passwords interactively. It may print a note recommending PKCS#12; both formats work.) A
PKCS#12 keystore must end in **`.pfx`**: the signer picks the keystore type from that extension.

Keep keystores **outside the repository**. If one has to live in the module folder, these names are git-ignored:
`prod*.jks`, `prod*.p7b`, and every `*.pfx`, `*.p12` and `*.keystore`. Check with `git check-ignore -v <file>` before
you commit. The committed dev keystore `simpletagdisplay.jks` is not affected by these patterns.

## Signing with a purchased certificate

A certificate from a public certificate authority (CA) lets every gateway see a verified publisher name. Steps
(**UNVERIFIED**: these steps have not yet been tried with a purchased certificate):

1. Buy an **RSA** code-signing certificate (the signer accepts RSA keys only).
2. Since 2023 CAs issue code-signing keys only on hardware (a USB token, an HSM or the CA's cloud signing service).
   The signer can use a PKCS#11 device: run it directly with `-pkcs11-cfg=<SunPKCS11 config file>` instead of
   `-keystore` ([below](#running-the-signer-directly)). `sign-module.ps1` does not pass that option.
3. If your CA gives you a PKCS#12 file instead, rename it to `.pfx` and use it as `CTG_KEYSTORE`. Keep it outside the
   repository (`.pfx` files are git-ignored, but a copy under another name would not be).
4. Use the full chain the CA delivers (your certificate plus intermediates) as `CTG_CERT_CHAIN`. A PEM bundle
   (several `-----BEGIN CERTIFICATE-----` blocks) or a `.p7b` file both work as input; the file is stored as-is.
5. Install the signed module on a test gateway and check that the certificate dialog shows your organisation.

## Running the signer directly

```powershell
$env:SIGN_PWD = Read-Host "Keystore password"
& "C:\Program Files\Java\jdk-17\bin\java.exe" -jar "module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar" `
    "-keystore=C:\secure\prod-tagdisplay.jks" "-keystore-pwd-env=SIGN_PWD" `
    "-alias=tagdisplay" "-alias-pwd-env=SIGN_PWD" `
    "-chain=C:\secure\prod-tagdisplay.p7b" `
    "-module-in=simple-tag-display\build\Tag-Display.unsigned.modl" `
    "-module-out=C:\out\Tag-Display.modl"
```

Quote every `-name=value` argument in PowerShell: unquoted, PowerShell splits
`-module-in=...\Tag-Display.unsigned.modl` at the first dot and the signer then looks for a file named `Tag-Display`.

| Option | Meaning |
|---|---|
| `-keystore=PATH` | `.jks` or `.pfx` keystore |
| `-keystore-pwd-env=VAR` / `-keystore-pwd=PWD` | keystore password from an environment variable (preferred) or the command line |
| `-alias=NAME`, `-alias-pwd-env=VAR` / `-alias-pwd=PWD` | key alias and its password |
| `-chain=PATH` | certificate chain stored as `certificates.p7b` |
| `-module-in=PATH`, `-module-out=PATH` | input and output module |
| `-pkcs11-cfg=PATH` | use a PKCS#11 token instead of a keystore file (UNVERIFIED) |
| `-v` | verbose output |

`build-and-sign.ps1` builds the signer jar automatically; by hand: `cd module-signer` then
`..\simple-tag-display\gradlew.bat build`.

## Checking a signed module

```powershell
.\simple-tag-display\build-and-sign.ps1 -VerifyModl C:\out\Tag-Display.modl    # jars, Java 17, version, build id
```

To see which certificate a module carries, extract `certificates.p7b` from the `.modl` (it is a zip) and run
`keytool -printcert -file certificates.p7b`.

<!-- nav:bottom -->

---

← Previous: [Deployment](06-deployment.md) · [Back to index](README.md) · Next: [Extending and contributing](08-extending-and-contributing.md) →

<!-- /nav:bottom -->
