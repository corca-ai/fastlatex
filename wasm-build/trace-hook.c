/* =============================================================================
 * trace-hook.c — Scan pdfTeX hash table post-compilation for LSP completions
 * =============================================================================
 *
 * After pdfTeX compiles a document, the WASM heap retains the full hash table
 * of ALL defined control sequences — base LaTeX, loaded packages, and user
 * definitions. This function scans the hash table and writes command names
 * to a MEMFS file that the worker JS reads and sends to the host.
 *
 * The scan is a read-only operation on the post-compilation WASM heap state.
 * It runs BEFORE restoreHeapMemory() is called for the next compilation.
 *
 * Hash table structure (from pdftexd.h, web2c generated):
 *   hash[514..hashtop]  — twohalves entries
 *   hash[p].v.RH        — string number of the CS name (0 = empty slot)
 *   hash[p].v.LH        — link to next entry in collision chain
 *   strpool[strstart[s]..strstart[s+1]-1] — characters of string s
 *
 * Constants:
 *   hashoffset = 514    — base index of hash array
 *   hashtop              — highest valid hash index
 *   26627                — frozen_control_sequence (undefined CS placeholder)
 *
 * Filters applied:
 *   - Skip empty slots (hash[p].v.RH == 0)
 *   - Skip undefined CS (zeqtb[p].hh eq_type == 0)
 *   - Skip single-character control sequences
 *   - Skip names containing '@' (internal LaTeX macros)
 *   - Skip names longer than 200 chars (sanity bound)
 * ========================================================================== */

#include <stdio.h>

/* --------------------------------------------------------------------------
 * Type definitions matching web2c wasm32 layout
 * (SIZEOF_LONG=4, little-endian, not SMALLTeX, not Aleph)
 *
 * We use standalone declarations instead of #include "pdftexd.h" to avoid
 * pulling in the full texmfmp.h include chain which can conflict with
 * Emscripten internals.
 * -------------------------------------------------------------------------- */

typedef int integer;
typedef int halfword;
typedef integer poolpointer;
typedef integer strnumber;
typedef unsigned char packedASCIIcode;

/* twohalves — used for hash[] entries and inside memoryword.hh */
typedef union {
    struct { halfword LH, RH; } v;      /* little-endian */
    struct { short B1, B0; } u;          /* B0 overlaps high 16 bits of LH */
} twohalves;

/* fourquarters — used inside memoryword */
typedef struct {
    struct { unsigned char B3, B2, B1, B0; } u;  /* little-endian */
} fourquarters;

/* memoryword — used for eqtb[] entries */
typedef double glueratio;
typedef union {
    glueratio gr;
    twohalves hh;
    struct { halfword junk; integer CINT; } u;
    struct { halfword junk; fourquarters QQQQ; } v;
} memoryword;

/* --------------------------------------------------------------------------
 * Extern declarations for pdfTeX globals
 * -------------------------------------------------------------------------- */

extern twohalves *hash;           /* hash table (offset by hashoffset=514) */
extern halfword hashtop;          /* highest valid hash index */
extern packedASCIIcode *strpool;  /* string character pool */
extern poolpointer *strstart;     /* string start indices */
extern strnumber strptr;          /* next free string number */
extern memoryword *zeqtb;        /* eqtb array (eq_type, equiv, eq_level) */

/* hashoffset: hash[514] is the first valid entry */
#define HASH_OFFSET 514

/* frozen_control_sequence: the "undefined CS" placeholder */
#define FROZEN_CS 26627

void scanHashTable(void)
{
    FILE *f = fopen("/work/.commands", "w");
    if (!f) return;

    int p;
    for (p = HASH_OFFSET; p <= hashtop; p++) {
        /* Skip the frozen "undefined control sequence" slot */
        if (p == FROZEN_CS) continue;

        /* Skip empty slots (no name string assigned) */
        strnumber s = hash[p].v.RH;
        if (s <= 0) continue;

        /* Skip undefined control sequences (eq_type == 0) */
        if (zeqtb[p].hh.u.B0 == 0) continue;

        /* Bounds check the string number */
        if (s >= strptr) continue;

        /* Get string length and content pointer */
        poolpointer start = strstart[s];
        poolpointer end = strstart[s + 1];
        int len = end - start;

        /* Skip single-character control sequences */
        if (len <= 1) continue;

        /* Skip names longer than 200 chars (sanity bound) */
        if (len > 200) continue;

        /* Check for internal markers and copy to buffer.
         * '@' = LaTeX2e internals, '_' and ':' = LaTeX3 (expl3) internals.
         * In standard LaTeX, '_' is subscript (catcode 8) and ':' is other
         * (catcode 12) — only expl3 makes them letters (catcode 11). */
        char buf[201];
        int skip = 0;
        int i;
        for (i = 0; i < len; i++) {
            unsigned char ch = strpool[start + i];
            if (ch == '@' || ch == '_' || ch == ':') { skip = 1; break; }
            buf[i] = (char)ch;
        }
        if (skip) continue;
        buf[len] = '\0';

        fprintf(f, "%s\t%d\n", buf, (int)zeqtb[p].hh.u.B0);
    }

    fclose(f);
}
