# Getting started with module-signer

## Prerequisites

* Java 11 installed and on your path.
* A Java Keystore (in jks or pfx format) containing either:
  * A self-generated and self-signed code signing certificate.
  * A code signing certificate, obtained from and signed by a CA, and the certificate chain that goes with it.

[Keystore Explorer](http://keystore-explorer.sourceforge.net/downloads.php) is an easy to use tool for creating and managing keystores and certificates.

## Invocation

Invocation from the command-line:
```
java -jar module-signer.jar \ 
	-keystore=<path-to-my-keystore>/keystore.jks \
	-keystore-pwd=<password> \
	-alias=server \
	-alias-pwd=<password> \
	-chain=<pathToMyp7b>/cert.p7b \
	-module-in=<path-to-my-module>/my-unsigned-module.modl \
	-module-out=<path-to-my-module>/my-signed-module.modl
```

## Parameters Explained

### keystore
The path to the keystore containing your code signing certificate. Can be either JKS or PFX format.

### keystore-pwd
The password to access the keystore.

### alias
The alias under which your code signing certificate is stored.

### alias-pwd
The password to access the alias.

### keystore-pwd-env / alias-pwd-env
Name of an environment variable that holds the keystore / alias password, e.g.
`-keystore-pwd-env=CTG_SIGN_KEYSTORE_PWD`. When given, it wins over `-keystore-pwd` / `-alias-pwd`.
Prefer this form: a password passed as `-keystore-pwd=...` is visible in the process list and in
EDR/audit logs of the machine. `sign-module.ps1` always uses the env form.

### chain
The path to the certificate chain (in p7b format). This file will is generally returned along with your signed certificate after submitting a CSR to a CA.

### module-in
The path to the unsigned module.

### module-out
The path the signed module will be written to.
