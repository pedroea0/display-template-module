@echo off
REM Module Signing Script for Simple Tag Display
REM This script helps sign the module using the module-signer tool
REM
REM Before running this script:
REM 1. Create a keystore with a code signing certificate
REM 2. Build the module-signer.jar tool
REM 3. Update the variables below with your actual values

set MODULE_SIGNER_JAR=..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar
set KEYSTORE=simpletagdisplay.jks
set KEYSTORE_PWD=simpletagdisplay123
set ALIAS=simpletagdisplay
set ALIAS_PWD=simpletagdisplay123
set CERT_CHAIN=simpletagdisplay.p7b
set MODULE_IN=build\Simple-Tag-Display.unsigned.modl
set MODULE_OUT=build\Simple-Tag-Display.modl

REM Check if module-signer.jar exists
if not exist "%MODULE_SIGNER_JAR%" (
    echo ERROR: module-signer.jar not found at: %MODULE_SIGNER_JAR%
    echo Please build it first using: cd ..\module-signer ^&^& mvn clean package
    pause
    exit /b 1
)

REM Check if unsigned module exists
if not exist "%MODULE_IN%" (
    echo ERROR: Unsigned module not found at: %MODULE_IN%
    echo Please build the module first using: gradlew build
    pause
    exit /b 1
)

REM Check if keystore exists
if not exist "%KEYSTORE%" (
    echo ERROR: Keystore not found at: %KEYSTORE%
    echo Please create a keystore first. See SIGNING_GUIDE.md for instructions.
    pause
    exit /b 1
)

echo Signing module...
echo.

REM Build the command - if CERT_CHAIN is empty, omit the -chain parameter
if "%CERT_CHAIN%"=="" (
    java -jar "%MODULE_SIGNER_JAR%" ^
        -keystore=%KEYSTORE% ^
        -keystore-pwd=%KEYSTORE_PWD% ^
        -alias=%ALIAS% ^
        -alias-pwd=%ALIAS_PWD% ^
        -module-in=%MODULE_IN% ^
        -module-out=%MODULE_OUT%
) else (
    java -jar "%MODULE_SIGNER_JAR%" ^
        -keystore=%KEYSTORE% ^
        -keystore-pwd=%KEYSTORE_PWD% ^
        -alias=%ALIAS% ^
        -alias-pwd=%ALIAS_PWD% ^
        -chain=%CERT_CHAIN% ^
        -module-in=%MODULE_IN% ^
        -module-out=%MODULE_OUT%
)

if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS: Module signed successfully!
    echo Signed module: %MODULE_OUT%
) else (
    echo.
    echo ERROR: Module signing failed!
    echo Check the error messages above.
)

pause

