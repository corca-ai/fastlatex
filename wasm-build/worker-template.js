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
//   preloadtexlive — pre-load a texlive file into MEMFS cache
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

// Semantic trace hooks: written to __strace.tex file, then \input'd right after
// \begin{document} in the source. Runs after all \AtBeginDocument hooks, capturing
// the FINAL definitions of \label/\ref/etc (post-hyperref and other packages).
// Uses \makeatletter for @ in names; avoids _ (catcode 8 in standard LaTeX).
var SEMANTIC_TRACE_TEX = [
    "\\makeatletter",
    "\\newwrite\\st@trace",
    "\\immediate\\openout\\st@trace=\\jobname.trace\\relax",
    "\\let\\st@orig@label\\label",
    "\\renewcommand{\\label}[1]{\\immediate\\write\\st@trace{L:#1}\\st@orig@label{#1}}%",
    "\\let\\st@orig@ref\\ref",
    "\\renewcommand{\\ref}[1]{\\immediate\\write\\st@trace{R:#1}\\st@orig@ref{#1}}%",
    "\\let\\st@orig@pageref\\pageref",
    "\\renewcommand{\\pageref}[1]{\\immediate\\write\\st@trace{R:#1}\\st@orig@pageref{#1}}%",
    "\\@ifundefined{eqref}{}{%",
    "  \\let\\st@orig@eqref\\eqref",
    "  \\renewcommand{\\eqref}[1]{\\immediate\\write\\st@trace{R:#1}\\st@orig@eqref{#1}}%",
    "}%",
    "\\makeatother",
    ""
].join("\n");

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

    // Remove the directory itself (unless it's a root dir)
    if (dir !== WORKROOT && dir !== TEXCACHEROOT) {
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

// --- DRY helpers -------------------------------------------------------------

// Write texmf.cnf so kpathsea can find fonts/styles and has enough memory.
function writeTexmfCnf() {
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
        "% Memory parameters (Optimized for TeX Live 2025)",
        "main_memory = 8000000",
        "extra_mem_top = 4000000",
        "extra_mem_bot = 4000000",
        "font_mem_size = 8000000",
        "pool_size = 5000000",
        "buf_size = 1000000",
        "hash_extra = 1000000",
        "save_size = 100000",
        "stack_size = 10000",
        "trie_size = 1000000",
        "hyph_size = 8191",
        "max_strings = 500000",
        "string_vacancies = 100000",
        "nest_size = 500",
        "param_size = 10000",
        ""
    ].join("\n");
    FS.writeFile(WORKROOT + "/texmf.cnf", texmfCnf);
}

// Run _main() directly, bypassing Emscripten's callMain().
// CRITICAL: We must NOT use Emscripten's callMain because it calls exitJS()
// which invokes exitRuntime(), setting runtimeExited=true. This flag is
// JavaScript-side state that prepareExecutionContext() does NOT restore
// (it only restores WASM heap memory). Subsequent calls then fail because
// the Emscripten runtime thinks it's already shut down.
//
// Instead, we call _main() directly and catch ExitStatus ourselves — exactly
// like the original base format build code on the main branch.
//
// args should NOT include the program name — it's prepended automatically.
// IMPORTANT: Do NOT name this function "callMain" — that would shadow
// Emscripten's version and break its internal uses.
function runMain(programName, args) {
    var savedProgram = thisProgram;
    thisProgram = "./" + programName;

    // Build argv: [programName, ...args, NULL]
    var fullArgs = [programName].concat(args);
    var argPtrs = fullArgs.map(allocateString);
    argPtrs.push(0); // NULL terminator
    var argv = _malloc(argPtrs.length * 4);
    var dv = new DataView(wasmMemory.buffer);
    for (var i = 0; i < argPtrs.length; i++) {
        dv.setUint32(argv + i * 4, argPtrs[i], true);
    }

    var status;
    try {
        status = _main(fullArgs.length, argv);
    } catch(e) {
        if (e instanceof ExitStatus) {
            status = e.status;
        } else {
            _free(argv);
            thisProgram = savedProgram;
            throw e;
        }
    }
    _free(argv);
    thisProgram = savedProgram;
    return status;
}

// --- Preamble snapshot -------------------------------------------------------

self._preambleHash = "";
self._preambleFmtData = null;
self._fmtIsNative = false;    // true only when base format was built by our WASM binary

// Split TeX source into preamble (before \begin{document}) and body (including it).
function extractPreamble(texSource) {
    var marker = "\\begin{document}";
    var searchFrom = 0;
    while (true) {
        var idx = texSource.indexOf(marker, searchFrom);
        if (idx === -1) return null;
        // Skip if \begin{document} is inside a comment
        var lineStart = texSource.lastIndexOf("\n", idx - 1) + 1;
        if (texSource.substring(lineStart, idx).indexOf("%") >= 0) {
            searchFrom = idx + marker.length;
            continue;
        }
        return {
            preamble: texSource.substring(0, idx),
            body: texSource.substring(idx),
            preambleLineCount: texSource.substring(0, idx).split("\n").length
        };
    }
}

// Simple string hash (djb2 variant). Returns a base-36 string.
function simpleHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h = h | 0;
    }
    return h.toString(36);
}

// Build a format file from the preamble text (everything before \begin{document}).
// Returns the format binary (Uint8Array) on success, null on failure.
function buildPreambleFormat(preambleText) {
    prepareExecutionContext();
    writeTexmfCnf();
    try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}

    // Base format must be available for -ini "&pdflatex"
    if (self._fmtData) {
        FS.writeFile(TEXCACHEROOT + "/pdflatex.fmt", self._fmtData);
        texlive200_cache["10/pdflatex.fmt"] = TEXCACHEROOT + "/pdflatex.fmt";
        FS.writeFile(WORKROOT + "/pdflatex.fmt", self._fmtData);
    }

    // preamble + \dump (no \begin{document})
    FS.writeFile(WORKROOT + "/_preamble.tex", preambleText + "\\dump\n");

    var status = runMain("pdflatex", ["-ini", "-interaction=nonstopmode",
                                       "&pdflatex", "_preamble.tex"]);

    if (status === 0) {
        // Check build log for errors that indicate a broken format
        if (self.memlog.includes("Fatal format file error") ||
            self.memlog.includes("I can\\'t go on")) {
            console.error("[preamble] build log contains fatal errors:");
            console.log(self.memlog);
            return null;
        }
        try {
            var fmt = FS.readFile(WORKROOT + "/_preamble.fmt", { encoding: "binary" });
            if (self._fmtData && fmt.length < self._fmtData.length * 0.5) {
                return null;
            }
            return fmt;
        } catch(e) { return null; }
    } else {
        console.error("[preamble] format build failed. log below:");
        console.log(self.memlog);
    }
    return null;
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
    
    // Strip leading '*' or '&' — INITEX/fmt loader prefixes.
    if (reqname.startsWith("*") || reqname.startsWith("&")) {
        reqname = reqname.substring(1);
    }

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
            // console.log("[kpse] Format file also written to " + wdpath);
        }

        texlive200_cache[cacheKey] = savepath;
        var ptr = allocateString(savepath);
        console.log("[kpse] Downloaded: " + reqname + " (" + format + ")");
        return ptr;
    } else {
        console.warn("[kpse] Failed: " + reqname + " (" + format + ") - status: " + xhr.status);
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
        console.log("[kpse] Downloaded PK: " + reqname + " (" + dpi + ")");
        return allocateString(savepath);
    } else {
        console.warn("[kpse] Failed PK: " + reqname + " (" + dpi + ") - status: " + xhr.status);
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

    // kpathsea does lstat(argv[0]) to find the program directory.
    try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}

    // Build format file on first compilation.
    if (!self._fmtData) {
        console.log("[compile] No preloaded format. Clearing caches and building initial format...");
        prepareExecutionContext();
        cleanDir(TEXCACHEROOT);
        cleanDir(WORKROOT);
        prepareExecutionContext();

        try { FS.writeFile(WORKROOT + "/pdfetex", ""); } catch(e) {}
        writeTexmfCnf();

        // Ensure no stale format file exists in WORKROOT before -ini run.
        // If a 2020 format is present, 2025 INITEX will be "stymied".
        try { FS.unlink(WORKROOT + "/pdflatex.fmt"); } catch(e) {}

        console.log("[compile] Invoking INITEX to build base format...");
        // Re-add * prefix to enable e-TeX extensions (required by modern LaTeX)
        // My JS fetcher fix will strip this '*' when downloading from S3.
        var fmtStatus = runMain("pdfetex", ["-ini", "-interaction=nonstopmode", "*pdflatex.ini"]);
        console.log("[compile] INITEX finished with status: " + fmtStatus);

        if (fmtStatus === 0) {
            try {
                self._fmtData = FS.readFile(WORKROOT + "/pdflatex.fmt", { encoding: "binary" });
                self._fmtBuiltThisSession = true;
                self._fmtIsNative = true;
                console.log("[compile] Initial format built successfully.");
            } catch(e) {
                console.error("[compile] Format build succeeded but can't read output: " + e);
            }
        } else {
            console.error("[compile] Initial format build failed. log below:");
            console.log(self.memlog);
            self.postMessage({
                "result": "failed",
                "status": fmtStatus,
                "log": self.memlog,
                "cmd": "compile"
            });
            return; // STOP HERE
        }
        prepareExecutionContext();
        try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}
    }

    // --- Preamble snapshot ---------------------------------------------------
    // Detect preamble changes and build a cached format to speed up body edits.
    // We swap which format file gets loaded via the kpse cache.
    var usedPreamble = false;
    var texSource = null;
    try { texSource = FS.readFile(WORKROOT + "/" + self.mainfile, { encoding: "utf8" }); }
    catch(e) {}

    var split = texSource ? extractPreamble(texSource) : null;

    if (split && self._fmtIsNative) {
        var hash = simpleHash(split.preamble);
        if (hash === self._preambleHash && self._preambleFmtData) {
            // Preamble cache HIT — reuse cached preamble format
            usedPreamble = true;
        } else {
            // Preamble cache MISS — build new preamble format.
            var fmtBuildStart = performance.now();
            var fmt = buildPreambleFormat(split.preamble);
            var fmtBuildMs = Math.round(performance.now() - fmtBuildStart);
            if (fmt) {
                console.log("[preamble] MISS — format built in " + fmtBuildMs + "ms");
                self._preambleFmtData = fmt;
                self._preambleHash = hash;
                usedPreamble = true;
                prepareExecutionContext();
                try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}
            } else {
                console.log("[preamble] MISS — format build failed (" + fmtBuildMs + "ms)");
                prepareExecutionContext();
                try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}
            }
        }

        if (usedPreamble) {
            // Write padded body to preserve SyncTeX line numbers
            var padding = "";
            for (var i = 1; i < split.preambleLineCount; i++) padding += "%\n";
            FS.writeFile(WORKROOT + "/" + self.mainfile, padding + split.body);
        }
    }

    // Write format to kpse cache — preamble format if available, else base format.
    // runMain() uses "&pdflatex" to load pdflatex.fmt via kpathsea, so swapping
    // the file in the cache transparently switches between full and preamble formats.
    var fmtToUse = usedPreamble ? self._preambleFmtData : self._fmtData;
    if (fmtToUse) {
        FS.writeFile(TEXCACHEROOT + "/swiftlatexpdftex.fmt", fmtToUse);
        texlive200_cache["10/swiftlatexpdftex.fmt"] = TEXCACHEROOT + "/swiftlatexpdftex.fmt";
        FS.writeFile(TEXCACHEROOT + "/pdflatex.fmt", fmtToUse);
        texlive200_cache["10/pdflatex.fmt"] = TEXCACHEROOT + "/pdflatex.fmt";
        // Also write to WORKROOT — open_fmt_file() tries fopen() in CWD first,
        // before falling back to kpathsea. "&pdflatex" in runMain() args tells
        // pdfTeX to look for pdflatex.fmt. Without this write, a stale base
        // pdflatex.fmt left by buildPreambleFormat() would be loaded instead.
        FS.writeFile(WORKROOT + "/pdflatex.fmt", fmtToUse);
    }

    // Semantic trace: write hook file and inject \input{__strace} after \begin{document}.
    // Placed on the same line to avoid shifting line numbers (SyncTeX, error reports).
    FS.writeFile(WORKROOT + "/__strace.tex", SEMANTIC_TRACE_TEX);
    try {
        var currentSrc = FS.readFile(WORKROOT + "/" + self.mainfile, { encoding: "utf8" });
        var bdTag = "\\begin{document}";
        var bdIdx = currentSrc.indexOf(bdTag);
        if (bdIdx >= 0) {
            var afterBD = bdIdx + bdTag.length;
            var injected = currentSrc.slice(0, afterBD) + "\\input{__strace}" + currentSrc.slice(afterBD);
            FS.writeFile(WORKROOT + "/" + self.mainfile, injected);
        }
    } catch(e) {}

    // Compile via runMain() — all compilation goes through the same _main() path,
    // allowing preamble format rebuilds at any point in the session.
    writeTexmfCnf();
    var compileStart = performance.now();
    var status;
    try {
        status = runMain("pdflatex", ["-interaction=nonstopmode", "-synctex=1",
                                       "-recorder", "&pdflatex", self.mainfile]);
    } catch(e) {
        if (e instanceof ExitStatus) {
            status = e.status;
        } else {
            // Emscripten abort() or other fatal error — do NOT re-throw.
            // Re-throwing skips file restore and response, hanging the host forever.
            console.error("[compile] runMain crashed: " + e);
            status = -254;
        }
    }
    var compileMs = Math.round(performance.now() - compileStart);

    // Restore original main.tex after compilation.
    // The preamble path replaces main.tex with a padded body, and the trace
    // injection adds \input{__strace} after \begin{document}. Restore the
    // original source so recompiles (e.g. "Rerun to get cross-references right")
    // see the correct content and extractPreamble() works.
    if (texSource) {
        FS.writeFile(WORKROOT + "/" + self.mainfile, texSource);
    }

    // If preamble compile failed or produced critical errors, fall back to full compile.
    // In nonstopmode, pdfTeX can return status 0 even with massive errors (e.g. missing
    // LaTeX kernel). Detect these by checking the log for telltale error patterns.
    var preambleHasCriticalErrors = usedPreamble && (
        self.memlog.includes("normalsize is not defined") ||
        self.memlog.includes("Undefined control sequence")
    );
    if (usedPreamble && (status !== 0 || preambleHasCriticalErrors)) {
        console.log("[preamble] fallback to full compile");
        self._preambleFmtData = null;
        self._preambleHash = "";
        usedPreamble = false;

        prepareExecutionContext();
        try { FS.writeFile(WORKROOT + "/pdflatex", ""); } catch(e) {}

        // Restore original file content and base format
        FS.writeFile(WORKROOT + "/" + self.mainfile, texSource);
        if (self._fmtData) {
            FS.writeFile(TEXCACHEROOT + "/swiftlatexpdftex.fmt", self._fmtData);
            texlive200_cache["10/swiftlatexpdftex.fmt"] = TEXCACHEROOT + "/swiftlatexpdftex.fmt";
            FS.writeFile(TEXCACHEROOT + "/pdflatex.fmt", self._fmtData);
            texlive200_cache["10/pdflatex.fmt"] = TEXCACHEROOT + "/pdflatex.fmt";
            // Must also write to WORKROOT — open_fmt_file() tries fopen() in CWD first.
            // Without this, the stale preamble format left by the normal compile path
            // would be loaded instead of the base format, causing permanent failure.
            FS.writeFile(WORKROOT + "/pdflatex.fmt", self._fmtData);
        }

        writeTexmfCnf();
        try {
            status = runMain("pdflatex", ["-interaction=nonstopmode", "-synctex=1",
                                           "-recorder", "&pdflatex", self.mainfile]);
        } catch(e) {
            if (e instanceof ExitStatus) {
                status = e.status;
            } else {
                console.error("[compile] fallback runMain crashed: " + e);
                status = -254;
            }
        }
    }

    console.log("[compile] " + compileMs + "ms" + (usedPreamble ? " (preamble HIT)" : ""));

    // Semantic Trace: extract defined commands from pdfTeX hash table.
    // Run regardless of exit status — the hash table is populated even when
    // pdfTeX returns status 1 (warnings / non-fatal errors).
    var engineCommands = null;
    try {
        _scanHashTable();
        var cmdData = FS.readFile(WORKROOT + "/.commands", { encoding: "utf8" });
        if (cmdData && cmdData.length > 0) {
            engineCommands = cmdData.trimEnd().split("\n");
        }
        try { FS.unlink(WORKROOT + "/.commands"); } catch(e2) {}
    } catch(e) {}

    // Read .fls (file recorder output) to discover input files.
    var baseName = self.mainfile.substr(0, self.mainfile.length - 4);
    var inputFiles = null;
    try {
        var flsData = FS.readFile(WORKROOT + "/" + baseName + ".fls", { encoding: "utf8" });
        if (flsData) {
            inputFiles = flsData.trimEnd().split("\n")
                .filter(function(l) { return l.startsWith("INPUT "); })
                .map(function(l) { return l.slice(6); })
                .filter(function(p) { return p.startsWith(WORKROOT + "/"); })
                .map(function(p) { return p.slice(WORKROOT.length + 1); })
                .filter(function(p) { return p.endsWith(".tex"); });
            // Deduplicate
            inputFiles = Array.from(new Set(inputFiles));
        }
        try { FS.unlink(WORKROOT + "/" + baseName + ".fls"); } catch(e2) {}
    } catch(e) {}

    // Read .trace (semantic trace output from \label/\ref hooks).
    var semanticTrace = null;
    try {
        var traceData = FS.readFile(WORKROOT + "/" + baseName + ".trace", { encoding: "utf8" });
        if (traceData && traceData.length > 0) {
            semanticTrace = traceData;
        }
        try { FS.unlink(WORKROOT + "/" + baseName + ".trace"); } catch(e2) {}
    } catch(e) {}

    // pdfTeX exit code 0 = success, 1 = completed with warnings/errors.
    // Both can produce valid PDF output, so try to read it for either.
    if (status === 0 || status === 1) {
        var pdfArrayBuffer = null;

        _compileBibtex();

        var pdfPath = WORKROOT + "/" + baseName + ".pdf";

        try {
            pdfArrayBuffer = FS.readFile(pdfPath, { encoding: "binary" });
        } catch(err) {
            console.error("Failed to read PDF output: " + pdfPath);
            self.postMessage({
                "result": "failed",
                "status": status,
                "log": self.memlog,
                "cmd": "compile",
                "engineCommands": engineCommands,
                "inputFiles": inputFiles,
                "semanticTrace": semanticTrace
            });
            return;
        }

        // SyncTeX extraction
        var synctexData = null;
        var synctexPath = WORKROOT + "/" + baseName + ".synctex";
        var synctexGzPath = WORKROOT + "/" + baseName + ".synctex.gz";

        try {
            synctexData = FS.readFile(synctexPath, { encoding: "binary" });
        } catch(e) {
            try {
                synctexData = FS.readFile(synctexGzPath, { encoding: "binary" });
            } catch(e2) {
                console.log("No synctex file found");
            }
        }

        var response = {
            "result": "ok",
            "status": status,
            "log": self.memlog,
            "pdf": pdfArrayBuffer.buffer,
            "cmd": "compile",
            "preambleSnapshot": usedPreamble,
            "engineCommands": engineCommands,
            "inputFiles": inputFiles,
            "semanticTrace": semanticTrace
        };

        var transferables = [pdfArrayBuffer.buffer];

        if (synctexData !== null) {
            response["synctex"] = synctexData.buffer;
            transferables.push(synctexData.buffer);
        }

        if (self._fmtBuiltThisSession) {
            var fmtCopy = new Uint8Array(self._fmtData);
            response["format"] = fmtCopy.buffer;
            transferables.push(fmtCopy.buffer);
            self._fmtBuiltThisSession = false;
        }

        self.postMessage(response, transferables);

    } else {
        console.error("Compilation failed, with status code " + status);
        self.postMessage({
            "result": "failed",
            "status": status,
            "log": self.memlog,
            "cmd": "compile",
            "preambleSnapshot": false,
            "engineCommands": engineCommands,
            "inputFiles": inputFiles,
            "semanticTrace": semanticTrace
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
            console.error("[compile] compileFormat crashed: " + e);
            status = -254;
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
        // Pre-load a format file (.fmt).
        var fmtData = new Uint8Array(data["data"]);
        console.log("[loadformat] received data, size: " + fmtData.length);
        self._fmtData = fmtData;
        self._fmtIsNative = true;
        self.postMessage({ "result": "ok", "cmd": "loadformat" });
    } else if (cmd === "preloadtexlive") {
        // Pre-load a texlive file from main thread (avoids sync XHR on first compile).
        // data: {format, filename, data: ArrayBuffer, msgId}
        var format = data["format"];
        var filename = data["filename"];
        var fileData = new Uint8Array(data["data"]);
        var msgId = data["msgId"];
        var cacheKey = format + "/" + filename;
        var savepath = TEXCACHEROOT + "/" + filename;
        FS.writeFile(savepath, fileData);
        texlive200_cache[cacheKey] = savepath;
        if (format === 10) {
            FS.writeFile(WORKROOT + "/" + filename, fileData);
        }
        self.postMessage({ "result": "ok", "cmd": "preloadtexlive", "msgId": msgId });
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
