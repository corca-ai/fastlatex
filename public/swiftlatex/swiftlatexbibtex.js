// BibTeX WASM Worker — stub for local development.
// The real WASM binary is built in CI from wasm-build/.
"use strict";

// Signal ready immediately
self.postMessage({ "result": "ok" });

self["onmessage"] = function(ev) {
  var data = ev.data;
  var cmd = data["cmd"];

  if (cmd === "compilebibtex") {
    self.postMessage({
      "cmd": "compile",
      "result": "error",
      "log": "BibTeX WASM not available (stub worker)"
    });
  } else if (cmd === "readfile") {
    self.postMessage({
      "cmd": "readfile",
      "result": "error",
      "data": null
    });
  } else if (cmd === "writefile") {
    // No-op in stub
  } else if (cmd === "mkdir") {
    // No-op in stub
  } else if (cmd === "settexliveurl") {
    // No-op in stub
  }
};
