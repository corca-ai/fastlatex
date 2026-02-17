/*
 * bibtex-worker-template.js — Web Worker for BibTeX WASM
 *
 * This file is prepended (--pre-js) to the emcc output to create
 * the final swiftlatexbibtex.js worker. It handles:
 *   - MEMFS setup (working directory + texlive cache)
 *   - Heap snapshot/restore for re-entrant compilations
 *   - kpathsea → network fallback for .bst files
 *   - Message protocol (writefile, mkdir, compilebibtex, readfile)
 */
"use strict";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
var TEXCACHEROOT = "/tex";
var WORKROOT = "/work";

/* ------------------------------------------------------------------ */
/* TexLive file caches                                                 */
/* ------------------------------------------------------------------ */
var texlive200_cache = {};
var texlive404_cache = {};
var fileid = 0;

/* ------------------------------------------------------------------ */
/* Emscripten Module hooks                                             */
/* ------------------------------------------------------------------ */
var Module = {};

Module["print"] = function(a) {
  self.memlog += a + "\n";
};

Module["printErr"] = function(a) {
  self.memlog += a + "\n";
};

Module["preRun"] = function() {
  FS.mkdir(TEXCACHEROOT);
  FS.mkdir(WORKROOT);
  FS.chdir(WORKROOT);
};

Module["postRun"] = function() {
  self.initmem = dumpHeapMemory();
  self.postMessage({ "result": "ok" });
};

Module["noExitRuntime"] = true;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
self.memlog = "";
self.texlive_endpoint = "";
self.mainfile = "main";

/* ------------------------------------------------------------------ */
/* Heap snapshot / restore                                             */
/* ------------------------------------------------------------------ */
function dumpHeapMemory() {
  return new Uint8Array(wasmMemory.buffer).slice();
}

function restoreHeapMemory() {
  var dst = new Uint8Array(wasmMemory.buffer);
  dst.set(self.initmem);
  /* CRITICAL: zero grown pages — memory.grow() during compilation
     leaves stale data that causes "already defined" errors. */
  if (dst.length > self.initmem.length) {
    dst.fill(0, self.initmem.length);
  }
}

/* ------------------------------------------------------------------ */
/* String allocation helpers                                           */
/* ------------------------------------------------------------------ */
function allocateString(str) {
  var encoder = new TextEncoder();
  var bytes = encoder.encode(str);
  var ptr = _malloc(bytes.length + 1);
  var heap = new Uint8Array(wasmMemory.buffer);
  heap.set(bytes, ptr);
  heap[ptr + bytes.length] = 0;
  return ptr;
}

/* ------------------------------------------------------------------ */
/* kpathsea network fallback (synchronous XHR)                         */
/* ------------------------------------------------------------------ */
function kpse_find_file_impl(nameptr, format, _mustexist) {
  var reqname = UTF8ToString(nameptr);
  var cacheKey = format + "/" + reqname;

  if (cacheKey in texlive404_cache) return 0;
  if (cacheKey in texlive200_cache) {
    return allocateString(texlive200_cache[cacheKey]);
  }

  if (!self.texlive_endpoint) return 0;

  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", self.texlive_endpoint + "pdftex/" + cacheKey, false);
    xhr.responseType = "arraybuffer";
    xhr.send();

    if (xhr.status === 200 && xhr.response) {
      fileid++;
      var savepath = TEXCACHEROOT + "/" + fileid;
      FS.writeFile(savepath, new Uint8Array(xhr.response));
      texlive200_cache[cacheKey] = savepath;
      return allocateString(savepath);
    }
  } catch (e) {
    /* Network error — treat as not found */
  }

  texlive404_cache[cacheKey] = true;
  return 0;
}

/* pk font finding (no-op for bibtex, but required by kpse hook) */
function kpse_find_pk_impl(_nameptr, _dpi) {
  return 0;
}

/* ------------------------------------------------------------------ */
/* runMain — direct _main() call (avoids Emscripten exitRuntime bug)   */
/* ------------------------------------------------------------------ */
function runMain(programName, args) {
  var fullArgs = [programName].concat(args);
  var argPtrs = fullArgs.map(allocateString);
  argPtrs.push(0);

  var argv = _malloc(argPtrs.length * 4);
  var heap32 = new Int32Array(wasmMemory.buffer);
  for (var i = 0; i < argPtrs.length; i++) {
    heap32[(argv >> 2) + i] = argPtrs[i];
  }

  var status;
  try {
    status = _main(fullArgs.length, argv);
  } catch (e) {
    if (typeof ExitStatus !== "undefined" && e instanceof ExitStatus) {
      status = e.status;
    } else {
      throw e;
    }
  }

  _free(argv);
  for (var j = 0; j < argPtrs.length - 1; j++) {
    _free(argPtrs[j]);
  }

  return status;
}

/* ------------------------------------------------------------------ */
/* compileBibtexRoutine                                                */
/* ------------------------------------------------------------------ */
function compileBibtexRoutine() {
  self.memlog = "";
  restoreHeapMemory();

  /* Close stale file descriptors */
  var keys = Object.keys(FS.streams);
  for (var i = 0; i < keys.length; i++) {
    var fd = parseInt(keys[i]);
    if (fd > 2 && FS.streams[fd]) {
      try { FS.close(FS.streams[fd]); } catch (e) { /* ignore */ }
    }
  }

  _setMainEntry(allocateString(self.mainfile));

  var status;
  try {
    status = _compileBibtex();
  } catch (e) {
    if (typeof ExitStatus !== "undefined" && e instanceof ExitStatus) {
      /* BibTeX always calls exit() — 0=ok, 1=warnings, 2=errors */
      status = e.status;
    } else {
      throw e;
    }
  }

  self.postMessage({
    "cmd": "compile",
    "result": status <= 1 ? "ok" : "error",
    "log": self.memlog
  });
}

/* ------------------------------------------------------------------ */
/* readFileRoutine                                                     */
/* ------------------------------------------------------------------ */
function readFileRoutine(url) {
  try {
    var data = FS.readFile(WORKROOT + "/" + url, { encoding: "utf8" });
    self.postMessage({ "cmd": "readfile", "result": "ok", "data": data });
  } catch (e) {
    self.postMessage({ "cmd": "readfile", "result": "error", "data": null });
  }
}

/* ------------------------------------------------------------------ */
/* Message handler                                                     */
/* ------------------------------------------------------------------ */
self["onmessage"] = function(ev) {
  var data = ev.data;
  var cmd = data["cmd"];

  if (cmd === "compilebibtex") {
    self.mainfile = data.url || "main";
    compileBibtexRoutine();
  } else if (cmd === "writefile") {
    try {
      FS.writeFile(WORKROOT + "/" + data.url, data.src);
    } catch (e) {
      /* Parent directory may not exist — create it */
      var parts = data.url.split("/");
      var dir = WORKROOT;
      for (var i = 0; i < parts.length - 1; i++) {
        dir += "/" + parts[i];
        try { FS.mkdir(dir); } catch (e2) { /* exists */ }
      }
      FS.writeFile(WORKROOT + "/" + data.url, data.src);
    }
  } else if (cmd === "mkdir") {
    try { FS.mkdir(WORKROOT + "/" + data.url); } catch (e) { /* exists */ }
  } else if (cmd === "readfile") {
    readFileRoutine(data.url);
  } else if (cmd === "settexliveurl") {
    self.texlive_endpoint = data.url;
  }
};
