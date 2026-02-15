// =============================================================================
// worker-template.js — Web Worker for pdfTeX WASM with SyncTeX
// =============================================================================
//
// This file is prepended to the Emscripten-generated JS (via --pre-js) to
// create a complete Web Worker that speaks the SwiftLaTeX worker protocol.
//
// The protocol uses postMessage with a {cmd, ...} object. Supported commands:
//   compilelatex   — compile the current .tex file, return PDF + SyncTeX
//   compileformat  — compile a format file (.fmt)
//   writefile      — write a file to the virtual filesystem
//   readfile       — read a file from the virtual filesystem
//   mkdir          — create a directory in the virtual filesystem
//   setmainfile    — set the main .tex entry point
//   settexliveurl  — set the TexLive package server endpoint
//   flushcache     — clear the working directory
//   grace          — gracefully shut down the worker
//
// Key difference from the original SwiftLaTeX worker:
//   After compilation, this worker reads the .synctex file from the WASM
//   virtual filesystem and includes it in the compile response message.
//   The engine is invoked with -synctex=1 to enable SyncTeX output.
//
// =============================================================================

// --- Constants ---------------------------------------------------------------

var TEXCACHEROOT = "/tex";  // Cache for downloaded TexLive packages
var WORKROOT = "/work";     // Working directory for compilation

// --- Worker state ------------------------------------------------------------

self.memlog = "";                // Captured stdout/stderr from pdfTeX
self.initmem = undefined;        // Snapshot of WASM heap after initialization
self.mainfile = "main.tex";      // Main .tex file to compile
self.texlive_endpoint = "";      // TexLive package server URL (set by host)

// --- Emscripten Module configuration -----------------------------------------
//
// This object is picked up by the Emscripten-generated code that follows
// this file (appended by emcc). It configures the WASM runtime before it
// starts loading.

var Module = {};

// Capture pdfTeX's stdout/stderr into self.memlog so we can return the
// compilation log to the host.
Module["print"] = function(a) {
    self.memlog += a + "\n";
};

Module["printErr"] = function(a) {
    self.memlog += a + "\n";
    console.log(a);
};

// Create the virtual filesystem directories before the WASM module starts.
Module["preRun"] = function() {
    FS.mkdir(TEXCACHEROOT);
    FS.mkdir(WORKROOT);
};

// After WASM initialization completes, snapshot the heap memory and notify
// the host that the engine is ready.
Module["postRun"] = function() {
    self.postMessage({ "result": "ok" });
    self.initmem = dumpHeapMemory();
};

// If the WASM engine crashes (abort), report failure to the host.
Module["onAbort"] = function() {
    self.memlog += "Engine crashed";
    self.postMessage({
        "result": "failed",
        "status": -254,
        "log": self.memlog,
        "cmd": "compile"
    });
    return;
};

// --- Heap memory management --------------------------------------------------
//
// pdfTeX modifies global state during compilation. To allow multiple
// compilations in the same worker, we snapshot the WASM heap after
// initialization and restore it before each compilation. This is much
// faster than re-initializing the entire WASM module.

function dumpHeapMemory() {
    var src = wasmMemory.buffer;
    var dst = new Uint8Array(src.byteLength);
    dst.set(new Uint8Array(src));
    return dst;
}

function restoreHeapMemory() {
    if (self.initmem === undefined) {
        console.error("Cannot restore heap: no snapshot taken");
        return;
    }
    var dst = new Uint8Array(wasmMemory.buffer);
    dst.set(self.initmem);
    // Zero out any memory beyond the initial snapshot.
    // memory.grow() during compilation expands the heap but restoreHeapMemory
    // only copies back the initial region — the grown pages retain stale data
    // from the previous compilation (TeX hash entries, macro definitions, input
    // stack frames). This causes "Command already defined" / "Can be used only
    // in preamble" / "text input levels exceeded" on subsequent compiles.
    if (dst.length > self.initmem.length) {
        dst.fill(0, self.initmem.length);
    }
}

// --- Virtual filesystem helpers ----------------------------------------------

// Close any open file streams in Emscripten's FS. This prevents "too many
// open files" errors across multiple compilations.
function closeFSStreams() {
    // Start at fd 3 — skip stdin (0), stdout (1), stderr (2).
    // Closing stdout/stderr breaks all pdfTeX output: C-side FILE structs
    // (restored by restoreHeapMemory) expect these fds to be open, but
    // JS-side FS.streams would be null → fd_write fails silently → exit(1).
    for (var i = 3; i < FS.streams.length; i++) {
        var stream = FS.streams[i];
        if (!stream) continue;
        try {
            FS.close(stream);
        } catch(e) {
            // Ignore errors closing already-closed streams
        }
    }
}

// Recursively remove all files and subdirectories under a directory.
// Used by flushcache to reset the working directory between compilations.
function cleanDir(dir) {
    var l = FS.readdir(dir);
    for (var i in l) {
        var item = l[i];
        if (item === "." || item === "..") continue;
        item = dir + "/" + item;

        var fsStat = undefined;
        try {
            fsStat = FS.stat(item);
        } catch(err) {
            console.error("Not able to fsstat " + item);
            continue;
        }

        if (FS.isDir(fsStat.mode)) {
            cleanDir(item);
        } else {
            try {
                FS.unlink(item);
            } catch(err) {
                console.error("Not able to unlink " + item);
            }
        }
    }

    // Remove the directory itself (unless it's the root working dir)
    if (dir !== WORKROOT) {
        try {
            FS.rmdir(dir);
        } catch(err) {
            console.error("Not able to rmdir " + dir);
        }
    }
}

// --- Execution context -------------------------------------------------------

// Prepare for a compilation by resetting the log, restoring the heap to its
// initial state, closing stale file streams, and changing to the working dir.
function prepareExecutionContext() {
    self.memlog = "";
    restoreHeapMemory();
    closeFSStreams();
    FS.chdir(WORKROOT);
}

// --- TexLive package fetching ------------------------------------------------
//
// When pdfTeX needs a file (font, style, etc.) that isn't in the virtual
// filesystem, kpathsea calls kpse_find_file_impl. This function fetches
// the file from the TexLive server via synchronous XHR and caches it.
//
// The caching uses two maps:
//   texlive200_cache: maps format/filename to the saved path (for hits)
//   texlive404_cache: maps format/filename to 1 (for misses)
//
// Cache entries persist across compilations. The 404 cache prevents
// repeated requests for files that don't exist on the server.

// Allocate a C-style null-terminated string on the WASM heap.
// Replaces deprecated allocate(intArrayFromString(...), "i8", ALLOC_NORMAL).
function allocateString(str) {
    var len = lengthBytesUTF8(str) + 1;
    var ptr = _malloc(len);
    stringToUTF8(str, ptr, len);
    return ptr;
}

var texlive404_cache = {};
var texlive200_cache = {};

function kpse_find_file_impl(nameptr, format, _mustexist) {
    var reqname = UTF8ToString(nameptr);
    console.log("[kpse] find_file: " + reqname + " (format=" + format + ")");

    // Only fetch bare filenames, not paths
    if (reqname.includes("/")) {
        return 0;
    }

    var cacheKey = format + "/" + reqname;

    // Check caches first
    if (cacheKey in texlive404_cache) {
        return 0;
    }
    if (cacheKey in texlive200_cache) {
        var savepath = texlive200_cache[cacheKey];
        return allocateString(savepath);
    }

    // Fetch from TexLive server
    var remote_url = self.texlive_endpoint + "pdftex/" + cacheKey;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", remote_url, false);  // Synchronous — required by kpathsea callback
    xhr.timeout = 150000;
    xhr.responseType = "arraybuffer";

    console.log("Start downloading texlive file " + remote_url);

    try {
        xhr.send();
    } catch(err) {
        console.log("TexLive Download Failed " + remote_url);
        return 0;
    }

    console.log("[kpse] XHR status=" + xhr.status + " statusText=" + xhr.statusText +
                " responseSize=" + (xhr.response ? xhr.response.byteLength : "null"));

    if (xhr.status === 200) {
        var arraybuffer = xhr.response;
        // fileid header comes from texlive server; static hosting won't have it
        var fileid = xhr.getResponseHeader("fileid") || reqname;
        var savepath = TEXCACHEROOT + "/" + fileid;
        var data = new Uint8Array(arraybuffer);
        FS.writeFile(savepath, data);

        // For format files (type 10), also write to working directory.
        // pdfTeX's open_fmt_file uses fopen() directly on the name from
        // pack_buffered_name — it does NOT use kpse_find_file's return path.
        // So the file must exist where fopen() looks: the working directory.
        if (format === 10) {
            var wdpath = WORKROOT + "/" + reqname;
            FS.writeFile(wdpath, data);
            console.log("[kpse] Format file also written to " + wdpath);
        }

        texlive200_cache[cacheKey] = savepath;
        var ptr = allocateString(savepath);
        return ptr;
    } else if (xhr.status === 301 || xhr.status === 404) {
        // 301: TexLive-Ondemand convention for "file not found"
        // 404: static hosting (gh-pages) for missing files
        console.log("TexLive File not exists " + remote_url);
        texlive404_cache[cacheKey] = 1;
        return 0;
    }

    return 0;
}

// --- PK font fetching --------------------------------------------------------
//
// Similar to kpse_find_file_impl but for PK (packed bitmap) fonts.
// These are fetched from a separate endpoint.

var pk404_cache = {};
var pk200_cache = {};

function kpse_find_pk_impl(nameptr, dpi) {
    var reqname = UTF8ToString(nameptr);

    if (reqname.includes("/")) {
        return 0;
    }

    var cacheKey = dpi + "/" + reqname;

    if (cacheKey in pk404_cache) {
        return 0;
    }
    if (cacheKey in pk200_cache) {
        var savepath = pk200_cache[cacheKey];
        return allocateString(savepath);
    }

    var remote_url = self.texlive_endpoint + "pdftex/pk/" + cacheKey;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", remote_url, false);
    xhr.timeout = 150000;
    xhr.responseType = "arraybuffer";

    console.log("Start downloading PK font " + remote_url);

    try {
        xhr.send();
    } catch(err) {
        console.log("PK Font Download Failed " + remote_url);
        return 0;
    }

    if (xhr.status === 200) {
        var arraybuffer = xhr.response;
        // pkid header comes from texlive server; static hosting won't have it
        var fileid = xhr.getResponseHeader("pkid") || reqname;
        var savepath = TEXCACHEROOT + "/" + fileid;
        FS.writeFile(savepath, new Uint8Array(arraybuffer));
        pk200_cache[cacheKey] = savepath;
        return allocateString(savepath);
    } else if (xhr.status === 301 || xhr.status === 404) {
        console.log("PK Font not exists " + remote_url);
        pk404_cache[cacheKey] = 1;
        return 0;
    }

    return 0;
}

// --- Compilation routines ----------------------------------------------------

// compileLaTeXRoutine — Main compilation entry point
//
// This is where SyncTeX integration happens. After pdfTeX compiles the
// document (with -synctex=1 implicitly enabled), we:
//   1. Read the generated PDF from the virtual filesystem
//   2. Read the generated .synctex file (if it exists)
//   3. Send both back to the host in the compile response
//
// The .synctex file contains source-to-PDF position mappings that enable
// click-to-jump between the editor and PDF viewer.
function compileLaTeXRoutine() {
    prepareExecutionContext();

    // Set the main .tex entry point in the WASM engine
    var setMainFunction = cwrap("setMainEntry", "number", ["string"]);
    setMainFunction(self.mainfile);

    // Run pdfTeX compilation
    // pdfTeX's main() calls exit() when done, which Emscripten turns into
    // a thrown ExitStatus exception. We catch it to extract the exit code.
    console.log("[compile] texlive_endpoint=" + self.texlive_endpoint + " mainfile=" + self.mainfile);
    console.log("[compile] /work/ contents:", JSON.stringify(FS.readdir(WORKROOT)));
    console.log("[compile] memlog before main():", JSON.stringify(self.memlog));

    // kpathsea does lstat(argv[0]) to find the program directory.
    // argv[0] is "pdflatex" which resolves to "./pdflatex" (cwd = /work).
    // Create a dummy file so the lstat succeeds.
    try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}

    // Build format file on first compilation.
    // The pre-built swiftlatexpdftex.fmt from the original SwiftLaTeX is
    // INCOMPATIBLE with our custom SyncTeX build (different string pool).
    // We must build a new one using our own binary via pdftex -ini.
    // LaTeX requires e-TeX — the "*" prefix in "*pdflatex.ini" activates it.
    // Since compileFormat() in wasm-entry.c doesn't use "*", we call _main()
    // directly with the correct arguments.
    if (!self._fmtData) {
        console.log("[compile] Building format file with e-TeX (first run)...");
        prepareExecutionContext();
        try { FS.writeFile(WORKROOT + "/pdfetex", ""); } catch(e) {}

        // Write texmf.cnf so kpathsea can find it. Without this, pdfTeX uses
        // tiny compiled-in defaults (trie_size=20000) which can't load all
        // hyphenation patterns from language.dat.
        var texmfCnf = [
            "% texmf.cnf for WASM pdfTeX — matches TeX Live 2020 defaults",
            "% Path configuration — kpathsea needs these to find files in CWD",
            "TEXINPUTS = .;" + TEXCACHEROOT + "//",
            "TFMFONTS = .;" + TEXCACHEROOT + "//",
            "T1FONTS = .;" + TEXCACHEROOT + "//",
            "AFMFONTS = .;" + TEXCACHEROOT + "//",
            "TEXFONTMAPS = .;" + TEXCACHEROOT + "//",
            "ENCFONTS = .;" + TEXCACHEROOT + "//",
            "VFFONTS = .;" + TEXCACHEROOT + "//",
            "TEXFORMATS = .;" + TEXCACHEROOT + "//",
            "TEXPOOL = .;" + TEXCACHEROOT + "//",
            "% Memory parameters",
            "main_memory = 5000000",
            "extra_mem_top = 2000000",
            "extra_mem_bot = 2000000",
            "font_mem_size = 8000000",
            "pool_size = 6250000",
            "buf_size = 200000",
            "hash_extra = 600000",
            "save_size = 80000",
            "stack_size = 5000",
            "trie_size = 1000000",
            "hyph_size = 8191",
            "nest_size = 500",
            "param_size = 10000",
            "max_strings = 500000",
            "string_vacancies = 90000",
            ""
        ].join("\n");
        FS.writeFile(WORKROOT + "/texmf.cnf", texmfCnf);

        // Build argv array on the WASM heap for: pdfetex -ini -interaction=nonstopmode *pdflatex.ini
        var fmtArgs = ["pdfetex", "-ini", "-interaction=nonstopmode", "*pdflatex.ini"];
        var fmtArgPtrs = fmtArgs.map(allocateString);
        fmtArgPtrs.push(0); // NULL terminator
        var fmtArgv = _malloc(fmtArgPtrs.length * 4);
        var dv = new DataView(wasmMemory.buffer);
        for (var fi = 0; fi < fmtArgPtrs.length; fi++) {
            dv.setUint32(fmtArgv + fi * 4, fmtArgPtrs[fi], true);
        }

        var fmtStatus;
        try {
            fmtStatus = _main(fmtArgs.length, fmtArgv);
        } catch(e) {
            if (e instanceof ExitStatus) {
                fmtStatus = e.status;
            } else {
                throw e;
            }
        }
        _free(fmtArgv);

        if (fmtStatus === 0) {
            try {
                self._fmtData = FS.readFile(WORKROOT + "/pdflatex.fmt", { encoding: "binary" });
                self._fmtBuiltThisSession = true;
                console.log("[compile] Format built: " + self._fmtData.length + " bytes");
            } catch(e) {
                console.error("[compile] Format build succeeded but can't read output: " + e);
            }
        } else {
            console.error("[compile] Format build FAILED (status=" + fmtStatus + "): " + self.memlog);
            // Fall back to preloaded format if available
            if (self._fmtFallback) {
                self._fmtData = self._fmtFallback;
                console.log("[compile] Using fallback format: " + self._fmtData.length + " bytes");
            }
        }
        // Re-prepare for the actual compilation
        prepareExecutionContext();
        try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}
    }

    // Write cached format to TEXCACHEROOT and pre-populate the kpse cache.
    // The binary's compiled-in format name is "swiftlatexpdftex", so pdfTeX
    // asks kpathsea for swiftlatexpdftex.fmt. Without this cache entry, the
    // JS hook would fetch the OLD incompatible format from the texlive server.
    if (self._fmtData) {
        FS.writeFile(TEXCACHEROOT + "/swiftlatexpdftex.fmt", self._fmtData);
        texlive200_cache["10/swiftlatexpdftex.fmt"] = TEXCACHEROOT + "/swiftlatexpdftex.fmt";
        // Also cache under pdflatex.fmt in case &pdflatex is processed
        FS.writeFile(TEXCACHEROOT + "/pdflatex.fmt", self._fmtData);
        texlive200_cache["10/pdflatex.fmt"] = TEXCACHEROOT + "/pdflatex.fmt";
    }

    // Final verification: are format files really in MEMFS?
    ["pdflatex.fmt", "swiftlatexpdftex.fmt"].forEach(function(n) {
        try {
            var s = FS.stat(TEXCACHEROOT + "/" + n);
            console.log("[compile] VERIFY " + n + ": " + s.size + " bytes in /tex/");
        } catch(e) {
            console.log("[compile] VERIFY " + n + ": MISSING from /tex/");
        }
    });
    console.log("[compile] kpse cache keys: " + JSON.stringify(Object.keys(texlive200_cache).filter(function(k) { return k.indexOf("fmt") >= 0; })));

    var status;
    try {
        status = _compileLaTeX();
    } catch(e) {
        if (e instanceof ExitStatus) {
            status = e.status;
            console.log("[compile] ExitStatus caught, code=" + status);
        } else {
            throw e;
        }
    }
    console.log("[compile] memlog after main():", JSON.stringify(self.memlog));

    if (status === 0) {
        // Compilation succeeded — read the PDF
        var pdfArrayBuffer = null;

        // BibTeX pass (for bibliography support)
        _compileBibtex();

        // Derive output filenames from the main .tex file
        var baseName = self.mainfile.substr(0, self.mainfile.length - 4);
        var pdfPath = WORKROOT + "/" + baseName + ".pdf";

        try {
            pdfArrayBuffer = FS.readFile(pdfPath, { encoding: "binary" });
        } catch(err) {
            console.error("Failed to read PDF output: " + pdfPath);
            status = -253;
            self.postMessage({
                "result": "failed",
                "status": status,
                "log": self.memlog,
                "cmd": "compile"
            });
            return;
        }

        // ---------------------------------------------------------------
        // SyncTeX extraction — NEW
        // ---------------------------------------------------------------
        // pdfTeX with SyncTeX enabled produces a .synctex or .synctex.gz
        // file alongside the PDF. We try to read it and include it in the
        // response so the editor can do source<->PDF position mapping.
        //
        // The synctex data is sent as a binary Uint8Array. The host-side
        // code is responsible for parsing it (using a SyncTeX parser).
        var synctexData = null;
        var synctexPath = WORKROOT + "/" + baseName + ".synctex";
        var synctexGzPath = WORKROOT + "/" + baseName + ".synctex.gz";

        try {
            // Try uncompressed first
            synctexData = FS.readFile(synctexPath, { encoding: "binary" });
        } catch(e) {
            // Try gzipped version
            try {
                synctexData = FS.readFile(synctexGzPath, { encoding: "binary" });
            } catch(e2) {
                // SyncTeX file not produced — this is normal if synctex is
                // disabled or compilation had issues. Not an error.
                console.log("No synctex file found (this is OK if synctex is disabled)");
            }
        }

        // Build the response message
        var response = {
            "result": "ok",
            "status": status,
            "log": self.memlog,
            "pdf": pdfArrayBuffer.buffer,
            "cmd": "compile"
        };

        // Transferable objects for zero-copy postMessage
        var transferables = [pdfArrayBuffer.buffer];

        // Include synctex data if available
        if (synctexData !== null) {
            response["synctex"] = synctexData.buffer;
            transferables.push(synctexData.buffer);
        }

        // Include format data when freshly built (so the host can save it)
        if (self._fmtBuiltThisSession) {
            var fmtCopy = new Uint8Array(self._fmtData);
            response["format"] = fmtCopy.buffer;
            transferables.push(fmtCopy.buffer);
            self._fmtBuiltThisSession = false;
        }

        self.postMessage(response, transferables);

    } else {
        // Compilation failed
        console.error("Compilation failed, with status code " + status);
        self.postMessage({
            "result": "failed",
            "status": status,
            "log": self.memlog,
            "cmd": "compile"
        });
    }
}

// compileFormatRoutine — Build a .fmt format file
//
// Format files are precompiled TeX macro packages (like LaTeX's pdflatex.fmt).
// This routine compiles one and returns it as binary data.
function compileFormatRoutine() {
    prepareExecutionContext();

    // Same dummy binary for kpathsea (argv[0] = "pdftex")
    try { FS.writeFile(WORKROOT + "/pdftex", ""); } catch(e) {}

    // Same ExitStatus handling as compileLaTeXRoutine
    var status;
    try {
        status = _compileFormat();
    } catch(e) {
        if (e instanceof ExitStatus) {
            status = e.status;
        } else {
            throw e;
        }
    }

    if (status === 0) {
        var fmtArrayBuffer = null;
        try {
            var fmtPath = WORKROOT + "/pdflatex.fmt";
            fmtArrayBuffer = FS.readFile(fmtPath, { encoding: "binary" });
        } catch(err) {
            console.error("Failed to read format file");
            status = -253;
            self.postMessage({
                "result": "failed",
                "status": status,
                "log": self.memlog,
                "cmd": "compile"
            });
            return;
        }
        self.postMessage({
            "result": "ok",
            "status": status,
            "log": self.memlog,
            "pdf": fmtArrayBuffer.buffer,
            "cmd": "compile"
        }, [fmtArrayBuffer.buffer]);
    } else {
        console.error("Compilation format failed, with status code " + status);
        self.postMessage({
            "result": "failed",
            "status": status,
            "log": self.memlog,
            "cmd": "compile"
        });
    }
}

// --- File I/O routines -------------------------------------------------------

function mkdirRoutine(dirname) {
    try {
        FS.mkdir(WORKROOT + "/" + dirname);
        self.postMessage({ "result": "ok", "cmd": "mkdir" });
    } catch(err) {
        console.error("Not able to mkdir " + dirname);
        self.postMessage({ "result": "failed", "cmd": "mkdir" });
    }
}

function writeFileRoutine(filename, content) {
    try {
        FS.writeFile(WORKROOT + "/" + filename, content);
        self.postMessage({ "result": "ok", "cmd": "writefile" });
    } catch(err) {
        console.error("Unable to write file " + filename);
        self.postMessage({ "result": "failed", "cmd": "writefile" });
    }
}

function setTexliveEndpoint(url) {
    if (url) {
        if (!url.endsWith("/")) {
            url += "/";
        }
        self.texlive_endpoint = url;
    }
}

// --- Message handler ---------------------------------------------------------
//
// This is the main entry point for the worker. The host sends commands via
// postMessage, and we dispatch them to the appropriate routine.
//
// The protocol is identical to the original SwiftLaTeX worker, with one
// addition: the compile response now includes a "synctex" field containing
// the raw SyncTeX data (when available).

self["onmessage"] = function(ev) {
    var data = ev["data"];
    var cmd = data["cmd"];

    if (cmd === "compilelatex") {
        compileLaTeXRoutine();
    } else if (cmd === "compileformat") {
        compileFormatRoutine();
    } else if (cmd === "settexliveurl") {
        setTexliveEndpoint(data["url"]);
    } else if (cmd === "mkdir") {
        mkdirRoutine(data["url"]);
    } else if (cmd === "writefile") {
        writeFileRoutine(data["url"], data["src"]);
    } else if (cmd === "setmainfile") {
        self.mainfile = data["url"];
    } else if (cmd === "loadformat") {
        // Pre-load a format file (.fmt) as a FALLBACK for when the texlive
        // server is unavailable (e.g. gh-pages). Stored separately from
        // _fmtData so the worker still tries to build a fresh format first.
        var fmtData = new Uint8Array(data["data"]);
        self._fmtFallback = fmtData;
        console.log("[loadformat] Fallback format loaded: " + fmtData.length + " bytes");
        self.postMessage({ "result": "ok", "cmd": "loadformat" });
    } else if (cmd === "grace") {
        console.error("Gracefully Close");
        self.close();
    } else if (cmd === "readfile") {
        // Read a file from the virtual filesystem and return its contents.
        try {
            var d = FS.readFile(
                WORKROOT + "/" + data["url"],
                { encoding: data["encoding"] || "utf8" }
            );
            self.postMessage({
                "result": "ok",
                "cmd": "readfile",
                "url": data["url"],
                "data": d
            });
        } catch(e) {
            self.postMessage({
                "result": "failed",
                "cmd": "readfile",
                "url": data["url"]
            });
        }
    } else if (cmd === "flushcache") {
        cleanDir(WORKROOT);
    } else {
        console.error("Unknown command " + cmd);
    }
};
