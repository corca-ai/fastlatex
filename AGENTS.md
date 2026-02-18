# LaTeX Editor Agent Guide

Browser-based LaTeX editor with real-time PDF preview.

> **IMPORTANT**: Before performing any task or modification, you MUST read the relevant documents listed below to ensure alignment with the project's architecture, conventions, and standards.

## Core Mission

To provide a high-performance, **embeddable LaTeX component** for academic platforms and collaboration tools.

## Documentation Index

- **[System Architecture](docs/architecture.md)**: Overview of the SDK structure, core components (VFS, LSP, Engines), and tech stack. Read this to understand how different modules interact.
- **[Integration Guide](docs/howto.md)**: Step-by-step instructions on embedding the editor, supporting BibTeX, and using Headless mode. Essential for usage-related tasks.
- **[API Reference](docs/api.md)**: Comprehensive documentation of the `LatexEditor` class methods, constructor options, and event system. Refer to this for any API changes or additions.
- **[WASM & TeX Live](docs/engine.md)**: Overview of the compilation engine and CDN.
- **[TeX Live Internals & Upgrade](docs/texlive-upgrade.md)**: Deep dive into the kpathsea fallback, S3 structure, and guide for upgrading to TeX Live 2025.
- **[Development Guide](docs/develop.md)**: Essential guide for contributors, covering environment setup, CLI commands, and testing strategies (Vitest/Playwright).

---
*For documentation maintenance rules, see [docs/metadoc.md](docs/metadoc.md).*
