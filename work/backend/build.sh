#!/bin/sh
set -eu
BACKEND_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JDK_BIN=${APPLE_HELPER_JDK_BIN:-/opt/homebrew/opt/openjdk@21/bin}
mkdir -p "$BACKEND_DIR/build/classes"
"$JDK_BIN/javac" --release 21 --add-modules jdk.httpserver -encoding UTF-8 -d "$BACKEND_DIR/build/classes" "$BACKEND_DIR"/src/*.java "$BACKEND_DIR"/test/*.java
"$JDK_BIN/jar" --create --file "$BACKEND_DIR/build/apple-helper.jar" --main-class AppleHelper -C "$BACKEND_DIR/build/classes" .
"$JDK_BIN/java" --add-modules jdk.httpserver -jar "$BACKEND_DIR/build/apple-helper.jar" --self-test
