# Documentation Guide

This document defines how to write and maintain project docs.

## Goal

Keep docs easy to scan and easy to trust for both humans and agents.

## Principles

- Treat docs like code.
- Keep intent explicit and concise.
- Prefer small focused docs over long mixed docs.
- Link related docs, but keep navigation short.
- Do not version control auto-generated docs.

## Structure

- Keep `README.md` minimal and point to `AGENTS.md`.
- Keep `AGENTS.md` minimal and link to detailed docs.
- Keep skill-specific docs inside each skill and link shared rules.

## Writing Rules

- Use stable terms consistent with current architecture.
- Remove outdated architecture terms immediately.
- Prefer examples that match current runtime behavior.

Note: `CLAUDE.md` is a symlink to `AGENTS.md`.
