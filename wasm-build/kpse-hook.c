/* =============================================================================
 * kpse-hook.c — Wraps kpse_find_file to add JS network fallback for WASM
 * =============================================================================
 *
 * Used with linker flag: -Wl,--wrap=kpse_find_file
 *
 * When pdfTeX can't find a file locally (MEMFS), this wrapper calls out to
 * JavaScript (kpse_find_file_js) which fetches the file from the TexLive
 * server via synchronous XHR.
 *
 * The --wrap mechanism works by:
 *   - Renaming all references to kpse_find_file → __wrap_kpse_find_file
 *   - Renaming the original definition → __real_kpse_find_file
 *   - Our __wrap version calls __real first, then falls back to JS
 * ========================================================================== */

/* The original kpse_find_file from libkpathsea.a (renamed by --wrap) */
extern char *__real_kpse_find_file(const char *name, int format,
                                   int must_exist);

/* JS function provided via --js-library library.js */
extern char *kpse_find_file_js(const char *name, int format, int must_exist);

char *__wrap_kpse_find_file(const char *name, int format, int must_exist)
{
    /* Try kpathsea's normal search first (checks MEMFS paths) */
    char *result = __real_kpse_find_file(name, format, must_exist);
    if (result)
        return result;

    /* Fall back to JS network fetch from TexLive server */
    return kpse_find_file_js(name, format, must_exist);
}
