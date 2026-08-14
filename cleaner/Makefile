# chartbay/cleaner — no dependencies, no cmake, no package manager.
#
#   make            build the native CLI at build/csvclean
#   make test       build and run the test binary
#   make wasm       build the browser module (needs emsdk on PATH)
#   make bench      time the CLI over a generated file
#   make clean

CXX      ?= c++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Iinclude
LDFLAGS  ?=

BUILD    := build
CORE_SRC := $(wildcard src/*.cpp)
CORE_OBJ := $(patsubst src/%.cpp,$(BUILD)/%.o,$(CORE_SRC))
TEST_SRC := $(wildcard tests/*.cpp)

.PHONY: all test wasm wasm-check bench clean

all: $(BUILD)/csvclean

$(BUILD):
	@mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/csvclean: $(CORE_OBJ) cli/main.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) $(CORE_OBJ) cli/main.cpp -o $@ $(LDFLAGS)

$(BUILD)/tests: $(CORE_OBJ) $(TEST_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) -Itests $(CORE_OBJ) $(TEST_SRC) -o $@ $(LDFLAGS)

test: $(BUILD)/tests wasm-check
	@./$(BUILD)/tests $(FILTER)

# ── WebAssembly ───────────────────────────────────────────────────────────────
# The module lands next to quantbay.bundle.js and, like it, is committed to the
# repo: Render's Python runtime has neither Node nor Emscripten, so nothing is
# compiled at deploy time.

EMCC     ?= em++
WASM_DIR := ../web/static/wasm
WASM_OUT := $(WASM_DIR)/csvclean.js

EM_EXPORTS := _cbc_alloc,_cbc_free,_cbc_create,_cbc_destroy,_cbc_feed,_cbc_finish,_cbc_error,_cbc_row_count,_cbc_column_count,_cbc_column_name,_cbc_column_type,_cbc_column_values,_cbc_column_mask,_cbc_column_codes,_cbc_level_count,_cbc_level_name,_cbc_text_blob,_cbc_text_offsets,_cbc_release_column,_cbc_report_json

EM_FLAGS := -std=c++17 -O3 -Iinclude -fexceptions \
            -sMODULARIZE=1 -sEXPORT_NAME=CsvCleanModule \
            -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4294967296 \
            -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64,HEAP32,UTF8ToString,lengthBytesUTF8,stringToUTF8 \
            -sEXPORTED_FUNCTIONS=$(EM_EXPORTS) \
            -sENVIRONMENT=web,worker -sFILESYSTEM=0 --no-entry

# Compiles the binding with the host compiler. Catches every type error in
# wasm/bindings.cpp without needing emsdk installed; part of `make test`.
wasm-check: | $(BUILD)
	$(CXX) $(CXXFLAGS) -fsyntax-only wasm/bindings.cpp

wasm:
	@command -v $(EMCC) >/dev/null || { \
	  echo "em++ no está en el PATH. Instalá emsdk:"; \
	  echo "  git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest"; \
	  echo "  source ./emsdk_env.sh"; exit 1; }
	@mkdir -p $(WASM_DIR)
	$(EMCC) $(EM_FLAGS) $(CORE_SRC) wasm/bindings.cpp -o $(WASM_OUT)
	@ls -lh $(WASM_DIR)

# ── Bench ─────────────────────────────────────────────────────────────────────

bench: $(BUILD)/csvclean
	@python3 tools/gen_csv.py $(BUILD)/bench.csv 2000000
	@ls -lh $(BUILD)/bench.csv
	@time ./$(BUILD)/csvclean $(BUILD)/bench.csv --out /dev/null --report $(BUILD)/bench.json
	@cat $(BUILD)/bench.json | head -40

clean:
	rm -rf $(BUILD)
