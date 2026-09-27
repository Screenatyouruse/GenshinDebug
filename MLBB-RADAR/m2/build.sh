#!/bin/bash
# m2 build — run via WSL:  bash /mnt/c/.../moba/m2/build.sh [--check]
set -e
SRC=/mnt/c/Users/berni/Desktop/a35project/moba/m2
NDKBIN=$HOME/android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/bin
CXX=$NDKBIN/aarch64-linux-android35-clang++

if [ "$1" = "--check" ]; then
    g++ -std=c++20 -fsyntax-only -Wall -Wno-unused-function "$SRC/cppport.cpp" && echo CHECK_OK
    exit 0
fi

"$CXX" -std=c++20 -O2 -Wall -Wno-unused-function -static-libstdc++ -o "$SRC/.audio_mixer" "$SRC/cppport.cpp"

NEEDED=$($NDKBIN/llvm-readelf -d "$SRC/.audio_mixer" | grep -c "libc++_shared" || true)
if [ "$NEEDED" != "0" ]; then
    echo "still dynamically linked - linking static archive explicitly"
    "$CXX" -std=c++20 -O2 -Wall -Wno-unused-function -o "$SRC/.audio_mixer" "$SRC/cppport.cpp" \
        $HOME/android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_static.a
fi

echo "BUILT $(date)"
ls -la "$SRC/.audio_mixer"
