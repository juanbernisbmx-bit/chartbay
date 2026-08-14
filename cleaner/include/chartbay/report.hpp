// Serialisation of a CleanResult. The JSON form is what the browser reads back
// out of WASM; the text form is what the CLI prints.
#pragma once

#include <string>

#include "chartbay/table.hpp"

namespace chartbay {

std::string to_json(const CleanResult& result);
std::string to_text(const CleanResult& result);

}  // namespace chartbay
