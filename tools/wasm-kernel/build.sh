#!/bin/sh
# Builds the WASM SIMD kernels with the system clang (wasm32 target) + wasm-ld. No emscripten/libc needed.
set -e
cd "$(dirname "$0")"
CF="--target=wasm32 -O3 -msimd128 -mbulk-memory -ffreestanding -nostdlib -fno-builtin -Wall -Wextra -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=65536"
clang $CF -DWQ=0  -o hwsyn_f32.wasm hwsyn_kernel.c
clang $CF -DWQ=16 -o hwsyn_i16.wasm hwsyn_kernel.c
clang $CF -DWQ=8  -o hwsyn_i8.wasm  hwsyn_kernel.c
clang $CF -DWQ=0 -DCACHETEST -o data/diag_cachetest_f32.wasm hwsyn_kernel.c
ls -l *.wasm
