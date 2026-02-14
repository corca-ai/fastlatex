/* =============================================================================
 * wasm-entry.c — Custom WASM entry points for the SwiftLaTeX worker protocol
 * =============================================================================
 *
 * Defines the C functions exported to JavaScript via Emscripten:
 *   compileLaTeX()   — compile the current .tex file with pdflatex
 *   compileBibtex()  — run bibtex (stub for now)
 *   compileFormat()  — build a .fmt format file
 *   setMainEntry()   — set the main .tex filename
 *
 * These wrap pdfTeX's main() function with appropriate arguments.
 * The worker JS calls restoreHeapMemory() before each invocation to
 * reset all global state, making main() safely re-callable.
 * ========================================================================== */

#include <string.h>

/* The main .tex file to compile, set by setMainEntry() */
static char main_entry[1024] = "main.tex";

/* pdfTeX's main function (defined in lib/main.c → lib/texmfmp.c) */
extern int main(int argc, char **argv);

int setMainEntry(const char *entry)
{
    strncpy(main_entry, entry, sizeof(main_entry) - 1);
    main_entry[sizeof(main_entry) - 1] = '\0';
    return 0;
}

int compileLaTeX(void)
{
    char *argv[] = {
        "pdflatex",
        "-interaction=nonstopmode",
        "-synctex=1",
        "&pdflatex",
        main_entry,
        NULL
    };
    return main(5, argv);
}

int compileBibtex(void)
{
    /* bibtex is a separate program — would need its own WASM build.
       For now, return 0 (success) as a no-op. The original SwiftLaTeX
       binary also had limited bibtex support. */
    return 0;
}

int compileFormat(void)
{
    char *argv[] = {
        "pdftex",
        "-ini",
        "-interaction=nonstopmode",
        "pdflatex.ini",
        NULL
    };
    return main(4, argv);
}
