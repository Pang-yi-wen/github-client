@echo off
rem Rebuild the APK from assets/index.html. Toolchain: C:\build-mv47 (JDK 17 + Android SDK 36.1).
rem After updating assets/index.html, bump versionCode/versionName in AndroidManifest.xml first.
rem The signing keystore lives at the project root (ghclient.jks) so that wiping
rem build/ cannot regenerate it: a new key would break in-place updates on phones.
setlocal enabledelayedexpansion
set BT=C:\build-mv47\sdk\build-tools\36.0.0
set JDK=C:\build-mv47\jdk-17.0.20.1+1
set AJ=C:\build-mv47\sdk\platforms\android-36.1\android.jar
set KS=ghclient.jks
set KSPASS=ghclient
cd /d "%~dp0"

if not exist build mkdir build
if not exist build\compiled mkdir build\compiled
if not exist build\classes mkdir build\classes
if not exist build\dex mkdir build\dex

echo [1/6] aapt2 compile
"%BT%\aapt2.exe" compile --dir res -o build\compiled.zip || goto :err

echo [2/6] aapt2 link
"%BT%\aapt2.exe" link -o build\base-unaligned.apk -I "%AJ%" --manifest AndroidManifest.xml build\compiled.zip -A assets || goto :err

echo [3/6] javac
"%JDK%\bin\javac.exe" -encoding UTF-8 --release 8 -classpath "%AJ%" -d build\classes src\com\pangyiwen\ghclient\MainActivity.java || goto :err

echo [4/6] d8
rem anonymous inner classes are not dexed automatically; list every .class explicitly
set D8IN=
for %%f in (build\classes\com\pangyiwen\ghclient\*.class) do set D8IN=!D8IN! "%%f"
"%JDK%\bin\java.exe" -cp "%BT%\lib\d8.jar" com.android.tools.r8.D8 --lib "%AJ%" --min-api 24 --output build\dex %D8IN% || goto :err

echo [5/6] add dex + zipalign
copy /y build\dex\classes.dex build\classes.dex >nul
pushd build
"%BT%\aapt.exe" add base-unaligned.apk classes.dex || (popd & goto :err)
popd
"%BT%\zipalign.exe" -f -p 4 build\base-unaligned.apk build\base-aligned.apk || goto :err

echo [6/6] sign
if not exist "%KS%" "%JDK%\bin\keytool.exe" -genkeypair -alias ghclient -keyalg RSA -keysize 2048 -validity 10000 -keystore "%KS%" -storepass %KSPASS% -keypass %KSPASS% -dname "CN=GitHub Client, O=Pang-yi-wen, C=CN"
"%JDK%\bin\java.exe" -cp "%BT%\lib\apksigner.jar" com.android.apksigner.ApkSignerTool sign --ks "%KS%" --ks-pass pass:%KSPASS% --key-pass pass:%KSPASS% --out "GitHubClient.apk" build\base-aligned.apk || goto :err

echo.
echo done: GitHubClient.apk
exit /b 0
:err
echo.
echo BUILD FAILED
exit /b 1
